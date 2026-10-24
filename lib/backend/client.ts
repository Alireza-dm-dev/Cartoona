import "server-only"
import { fetchWithTimeout, isFetchTimeoutError } from "@/lib/http/fetch-with-timeout"
import { logEvent } from "@/lib/observability/logger"
import { REQUEST_ID_HEADER, isSafeRequestId } from "@/lib/observability/request-id"
import {
  INTERNAL_AUTH_HEADER,
  InternalAuthConfigError,
  readInternalAuthSecret,
  signAssertion,
  signServiceAssertion,
  signWriteAssertion,
  type InternalService,
} from "@/lib/identity/assertion"
import type { VerifiedIdentity } from "@/lib/identity/types"
import { BackendConfigError, readBackendClientConfig } from "./config"
import { BackendClientError } from "./errors"

/**
 * Server-to-server HTTP client for the Fastify backend (V0.1.41).
 *
 * Used by Next.js route handlers acting as a BFF:
 *
 *   Browser -> Next route -> backendGetJson() -> Fastify -> PostgreSQL
 *
 * - Server only (`server-only`): importing it from a Client Component fails the
 *   build, so the internal address cannot reach a browser bundle.
 * - Native fetch through the existing `fetchWithTimeout`; no HTTP library.
 * - ONE attempt per call. No retry, no fallback: the caller decides what an
 *   outage means (for creation pricing: the public 503, never another source).
 * - Never cached by Next (`cache: "no-store"`), never follows redirects.
 * - The caller's request id is forwarded (when well-formed) so one logical
 *   request has one id across Next and Fastify.
 * - Failures surface only as `BackendClientError` with a safe `kind`, and are
 *   logged with allow-listed fields: request id, operation, status, duration,
 *   category. Never the URL, headers, response body or the raw exception.
 *
 * Authenticated calls (V0.1.42; session evidence V0.1.43): pass the `auth`
 * context an auth adapter verified. The client signs a short-lived internal
 * assertion (v2) carrying the provider subject and the verified sign-in time,
 * bound to this method, path and request id (lib/identity/assertion.ts), and
 * sends it in X-Cartoona-Internal-Auth. No provider token, cookie or user id is
 * forwarded.
 *
 * Callers of backendGetJson: /api/creation-pricing (public), /api/auth/backend-me,
 * the parent orders LIST and the V0.1.46 account reads.
 *
 * Writes (V0.1.47): backendWriteJson. The body is serialized ONCE; those exact
 * bytes are both hashed into the v3 assertion (`bdg`, with a fresh nonce) and
 * sent, so Fastify can verify the body it received is the body that was
 * signed. Still one attempt, never retried: a write that timed out may have
 * committed, so the error carries `outcomeUnknown` and the caller decides
 * what to tell the user. Method and path are constants in route handlers;
 * nothing a browser sends selects them. No caller yet: the first BFF write
 * cutover is V0.1.48.
 */

export interface BackendGetRequest<T> {
  /** Stable name for logs, e.g. "creation_pricing". */
  operation: string
  /** Absolute path on the backend, e.g. "/v1/creation-pricing". No query string. */
  path: string
  /**
   * Query parameters (V0.1.45). Undefined values are omitted. Names are
   * constants in route handlers; values are caller input already validated
   * by the route and are URL-encoded here. The assertion binds method + path,
   * not the query: a query only selects within the caller's own data.
   */
  query?: Record<string, string | undefined>
  /** The inbound request's id. Replaced by a fresh UUID when absent or unsafe. */
  requestId?: string
  /**
   * Validates and narrows the JSON body; throwing marks the response invalid.
   * Called for 2xx, and for any status listed in `acceptStatuses`.
   */
  parse: (json: unknown, status: number) => T
  /** Non-2xx statuses whose JSON body the caller wants (e.g. 401/403 auth outcomes). */
  acceptStatuses?: readonly number[]
  /** A VERIFIED auth context to assert to the backend; omit for public endpoints. */
  auth?: { identity: VerifiedIdentity; authenticatedAt: number }
}

export interface BackendResponse<T> {
  status: number
  data: T
  /** The id the backend echoed in X-Request-Id, if it was well-formed. */
  backendRequestId: string | null
  durationMs: number
}

export interface BackendClientDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}

/** Far beyond any internal JSON this client reads; stops a runaway response. */
export const BACKEND_MAX_BODY_CHARS = 256 * 1024

// Segments of [A-Za-z0-9_-] only: no "//", ".", "..", query or fragment.
const PATH = /^(\/[A-Za-z0-9_-]+)+$/
const QUERY_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/
const QUERY_VALUE_MAX = 512

function queryString(query: Record<string, string | undefined> | undefined): string {
  if (!query) return ""
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (!QUERY_NAME.test(name)) throw new TypeError("backend client: invalid query name")
    if (value === undefined) continue
    if (typeof value !== "string" || value.length > QUERY_VALUE_MAX) throw new TypeError("backend client: invalid query value")
    params.append(name, value)
  }
  const text = params.toString()
  return text ? `?${text}` : ""
}

export type BackendWriteMethod = "POST" | "PUT" | "PATCH" | "DELETE"

export interface BackendWriteRequest<T> {
  /** Stable name for logs, e.g. "parent_profile_update". */
  operation: string
  method: BackendWriteMethod
  /** Absolute backend path, a constant. No query string on writes. */
  path: string
  /** JSON-serializable body; serialized exactly once. */
  body: unknown
  requestId?: string
  parse: (json: unknown, status: number) => T
  acceptStatuses?: readonly number[]
  /** Required: every backend write is authenticated. */
  auth: { identity: VerifiedIdentity; authenticatedAt: number }
}

const WRITE_METHODS = new Set<string>(["POST", "PUT", "PATCH", "DELETE"])

export async function backendGetJson<T>(
  request: BackendGetRequest<T>,
  deps: BackendClientDeps = {},
): Promise<BackendResponse<T>> {
  if (!PATH.test(request.path)) {
    // A programming error, not input: paths are constants in route handlers.
    throw new TypeError("backend client: invalid path")
  }
  return send(
    {
      operation: request.operation,
      method: "GET",
      path: request.path,
      search: queryString(request.query),
      requestId: request.requestId,
      parse: request.parse,
      acceptStatuses: request.acceptStatuses,
      auth: request.auth,
    },
    deps,
  )
}

/**
 * One authenticated WRITE to the backend (V0.1.47). Signs a v3 assertion over
 * the exact serialized body with a fresh single-use nonce. Exactly one fetch;
 * never retried. See the header comment and BackendClientError.outcomeUnknown.
 */
export async function backendWriteJson<T>(
  request: BackendWriteRequest<T>,
  deps: BackendClientDeps = {},
): Promise<BackendResponse<T>> {
  if (!WRITE_METHODS.has(request.method)) throw new TypeError("backend client: invalid write method")
  if (!PATH.test(request.path)) throw new TypeError("backend client: invalid path")
  if (!request.auth) throw new TypeError("backend client: writes are authenticated")
  const body = JSON.stringify(request.body)
  if (typeof body !== "string") throw new TypeError("backend client: body is not JSON-serializable")
  return send(
    {
      operation: request.operation,
      method: request.method,
      path: request.path,
      search: "",
      body: new TextEncoder().encode(body),
      requestId: request.requestId,
      parse: request.parse,
      acceptStatuses: request.acceptStatuses,
      auth: request.auth,
    },
    deps,
  )
}

export interface BackendServiceWriteRequest<T> {
  operation: string
  /** Absolute backend path, a constant. */
  path: string
  body: unknown
  requestId?: string
  parse: (json: unknown, status: number) => T
  acceptStatuses?: readonly number[]
  /** The internal service the caller acts as AFTER verifying an external party (V0.1.51: "payments"). */
  service: InternalService
}

/**
 * One SERVICE write (V0.1.51): an s1 assertion (body digest + nonce) naming an
 * internal service, for calls that have no parent behind them - a payment
 * provider event the caller has already verified. POST only, one attempt,
 * never retried (same outcomeUnknown rules as backendWriteJson).
 */
export async function backendServiceWriteJson<T>(
  request: BackendServiceWriteRequest<T>,
  deps: BackendClientDeps = {},
): Promise<BackendResponse<T>> {
  if (!PATH.test(request.path)) throw new TypeError("backend client: invalid path")
  const body = JSON.stringify(request.body)
  if (typeof body !== "string") throw new TypeError("backend client: body is not JSON-serializable")
  return send(
    {
      operation: request.operation,
      method: "POST",
      path: request.path,
      search: "",
      body: new TextEncoder().encode(body),
      requestId: request.requestId,
      parse: request.parse,
      acceptStatuses: request.acceptStatuses,
      service: request.service,
    },
    deps,
  )
}

interface SendRequest<T> {
  operation: string
  method: "GET" | BackendWriteMethod
  path: string
  search: string
  /** Write only: the exact bytes signed and sent. */
  body?: Uint8Array<ArrayBuffer>
  requestId?: string
  parse: (json: unknown, status: number) => T
  acceptStatuses?: readonly number[]
  auth?: { identity: VerifiedIdentity; authenticatedAt: number }
  /** Service write (s1); exclusive with `auth`. */
  service?: InternalService
}

async function send<T>(request: SendRequest<T>, deps: BackendClientDeps): Promise<BackendResponse<T>> {
  const requestId = isSafeRequestId(request.requestId) ? request.requestId : crypto.randomUUID()
  const base = { requestId, operation: request.operation, subsystem: "backend" } as const
  const isWrite = request.body !== undefined
  const search = request.search

  let config
  try {
    config = readBackendClientConfig(deps.env)
  } catch (error) {
    if (!(error instanceof BackendConfigError)) throw error
    logEvent("error", "BACKEND_NOT_CONFIGURED", { ...base, errorCode: "BACKEND_NOT_CONFIGURED" })
    throw new BackendClientError("not_configured")
  }

  const headers: Record<string, string> = { accept: "application/json", [REQUEST_ID_HEADER]: requestId }
  if (request.service) {
    try {
      const secret = readInternalAuthSecret(deps.env)
      headers[INTERNAL_AUTH_HEADER] = signServiceAssertion({
        service: request.service,
        requestId,
        method: request.method,
        path: request.path,
        body: request.body!,
        secret,
      })
    } catch (error) {
      if (!(error instanceof InternalAuthConfigError)) throw error
      logEvent("error", "BACKEND_NOT_CONFIGURED", { ...base, errorCode: "INTERNAL_AUTH_NOT_CONFIGURED" })
      throw new BackendClientError("not_configured")
    }
  } else if (request.auth) {
    try {
      const secret = readInternalAuthSecret(deps.env)
      const claims = {
        identity: request.auth.identity,
        authenticatedAt: request.auth.authenticatedAt,
        requestId,
        method: request.method,
        path: request.path,
        secret,
      }
      headers[INTERNAL_AUTH_HEADER] = isWrite ? signWriteAssertion({ ...claims, body: request.body! }) : signAssertion(claims)
    } catch (error) {
      if (!(error instanceof InternalAuthConfigError)) throw error
      logEvent("error", "BACKEND_NOT_CONFIGURED", { ...base, errorCode: "INTERNAL_AUTH_NOT_CONFIGURED" })
      throw new BackendClientError("not_configured")
    }
  }

  const started = performance.now()
  const duration = () => performance.now() - started
  const fail = (
    kind: BackendClientError["kind"],
    event: string,
    level: "warn" | "error",
    errorCode: string,
    status: number | null = null,
  ): never => {
    // A write that got no usable answer may still have committed.
    const outcomeUnknown = isWrite && kind !== "not_configured" && !(kind === "bad_status" && status !== null && status < 500)
    logEvent(level, event, { ...base, status: status ?? undefined, durationMs: duration(), errorCode, ...(isWrite ? { outcomeUnknown } : {}) })
    throw new BackendClientError(kind, status, outcomeUnknown)
  }

  let response: Response
  try {
    response = await fetchWithTimeout(
      `${config.baseUrl}${request.path}${search}`,
      {
        method: request.method,
        headers: isWrite ? { ...headers, "content-type": "application/json" } : headers,
        ...(isWrite ? { body: request.body } : {}),
        cache: "no-store",
        redirect: "error",
      },
      config.timeoutMs,
      deps.fetchImpl,
    )
  } catch (error) {
    if (isFetchTimeoutError(error)) return fail("timeout", "BACKEND_TIMEOUT", "warn", "REQUEST_TIMEOUT")
    return fail("unavailable", "BACKEND_UNAVAILABLE", "warn", "BACKEND_UNAVAILABLE")
  }

  if (!response.ok && !request.acceptStatuses?.includes(response.status)) {
    await response.body?.cancel().catch(() => {})
    return fail("bad_status", "BACKEND_UNAVAILABLE", "warn", "BACKEND_BAD_STATUS", response.status)
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    // The deadline also covers the body; a stall or reset mid-body lands here.
    if (isFetchTimeoutError(error)) return fail("timeout", "BACKEND_TIMEOUT", "warn", "REQUEST_TIMEOUT")
    return fail("unavailable", "BACKEND_UNAVAILABLE", "warn", "BACKEND_UNAVAILABLE")
  }

  let data: T
  try {
    if (text.length > BACKEND_MAX_BODY_CHARS) throw new Error("too large")
    data = request.parse(JSON.parse(text), response.status)
  } catch {
    return fail("invalid_response", "BACKEND_INVALID_RESPONSE", "error", "BACKEND_INVALID_RESPONSE", response.status)
  }

  const echoed = response.headers.get(REQUEST_ID_HEADER)
  const durationMs = duration()
  logEvent("info", "BACKEND_REQUEST_COMPLETED", { ...base, status: response.status, durationMs })
  return {
    status: response.status,
    data,
    backendRequestId: isSafeRequestId(echoed) ? echoed : null,
    durationMs,
  }
}

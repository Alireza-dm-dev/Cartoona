import "server-only"

import type { VerifiedIdentity } from "@/lib/identity/types"
import { backendGetJson, backendWriteJson, type BackendWriteMethod } from "@/lib/backend/client"
import { isBackendClientError } from "@/lib/backend/errors"
import { currentRequestId } from "@/lib/observability/request-context"

/**
 * One generic way for Next code to call a JSON backend route (V0.1.53), used by
 * the referral, homepage and examples loaders. Each call is ONE attempt, never
 * retried. Reads may be anonymous (`context = null`, public content) or carry a
 * v2 assertion; writes always carry a v3 assertion for the verified caller.
 *
 * The result is a closed set: success with the backend's JSON body, or one of
 *   auth        the backend refused the CALLER (401/403: not signed in, session
 *               over, identity not linked, not allowed for this role)
 *   refused     a business answer (400/404/409/422/429) with its `{ error }` token
 *   unavailable the backend/database could not answer (5xx, timeout, refused
 *               connection, malformed body). For a write `outcomeUnknown` is
 *               true: it may have committed, so callers must not say "not saved".
 */

/** A verified caller as the backend client takes it (provider-neutral; the Supabase adapter's context has exactly this shape). */
export type VerifiedAuthContext = { identity: VerifiedIdentity; authenticatedAt: number }

export type CallOk = { ok: true; status: number; body: Record<string, unknown> }
export type CallFailure =
  | { ok: false; kind: "auth"; reason: "unauthenticated" | "session_expired" | "session_invalidated" | "identity_not_linked" | "forbidden" }
  | { ok: false; kind: "refused"; status: number; error: string; body: Record<string, unknown> }
  | { ok: false; kind: "unavailable"; outcomeUnknown: boolean }
export type CallResult = CallOk | CallFailure

type Outcome = { status: number; body: Record<string, unknown> }
const relay = (json: unknown, status: number): Outcome => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body")
  return { status, body: json as Record<string, unknown> }
}
const ACCEPT = [400, 401, 403, 404, 409, 413, 422, 429, 503] as const
const AUTH_REASONS = new Set(["unauthenticated", "session_expired", "session_invalidated", "identity_not_linked", "forbidden"])

function classify(out: Outcome, isWrite: boolean): CallResult {
  if (out.status >= 200 && out.status < 300) return { ok: true, status: out.status, body: out.body }
  const error = typeof out.body.error === "string" ? out.body.error : ""
  if (out.status === 409 && error === "replayed_request") return { ok: false, kind: "unavailable", outcomeUnknown: true }
  if ((out.status === 401 || out.status === 403) && AUTH_REASONS.has(error)) {
    return { ok: false, kind: "auth", reason: error as Extract<CallFailure, { kind: "auth" }>["reason"] }
  }
  if (out.status === 401) return { ok: false, kind: "auth", reason: "unauthenticated" }
  if (out.status === 503) return { ok: false, kind: "unavailable", outcomeUnknown: isWrite }
  return { ok: false, kind: "refused", status: out.status, error, body: out.body }
}

export async function callGet(
  context: VerifiedAuthContext | null,
  operation: string,
  path: string,
  query?: Record<string, string | undefined>,
): Promise<CallResult> {
  try {
    const { data } = await backendGetJson({
      operation,
      path,
      query,
      requestId: currentRequestId(),
      ...(context ? { auth: context } : {}),
      acceptStatuses: ACCEPT,
      parse: relay,
    })
    return classify(data, false)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: false }
    throw error
  }
}

export async function callWrite(
  context: VerifiedAuthContext,
  operation: string,
  method: BackendWriteMethod,
  path: string,
  body: unknown,
): Promise<CallResult> {
  try {
    const { data } = await backendWriteJson({
      operation,
      method,
      path,
      body,
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: ACCEPT,
      parse: relay,
    })
    return classify(data, true)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: error.outcomeUnknown }
    throw error
  }
}

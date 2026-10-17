import { NextResponse } from "next/server"
import { verifySupabaseIdentity } from "@/lib/auth/supabase-identity-adapter"
import { backendGetJson } from "@/lib/backend/client"
import { isBackendClientError } from "@/lib/backend/errors"
import { isPrincipalRole, type PrincipalRole } from "@/lib/identity/types"
import { currentRequestId, log, withObservability } from "@/lib/observability/request-context"

/**
 * GET /api/auth/backend-me - proof of the authenticated chain (V0.1.42):
 *
 *   browser session cookie
 *     -> Supabase Auth adapter (server-side verification, bounded deadline)
 *     -> signed internal assertion (never seen by the browser)
 *     -> Fastify GET /v1/auth/me
 *     -> user_identities + users in PostgreSQL
 *
 * The browser can influence only its own session cookie. Any identity it sends
 * (X-User-Id, X-Role, query, body) is never read. No business data moves through
 * this route; it answers who the backend thinks the caller is.
 *
 *   200 { authenticated: true, userId, role }   role from public.users
 *   401 { error: "unauthenticated" }             no session / session rejected
 *   403 { error: "identity_not_linked" }         verified, but no Cartoona user mapped
 *   403 { error: "forbidden" }                   linked account not allowed (deleted)
 *   503 { error: "auth_unavailable" }            identity provider down or too slow
 *   503 { error: "service_unavailable" }         backend down, misconfigured, or rejected our assertion
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type BackendMe =
  | { kind: "ok"; userId: string; role: PrincipalRole }
  | { kind: "rejected"; status: 401 | 403; error: "unauthenticated" | "identity_not_linked" | "forbidden" }

function parseBackendMe(json: unknown, status: number): BackendMe {
  const body = (json ?? {}) as Record<string, unknown>
  if (status === 200) {
    if (body.authenticated !== true || typeof body.userId !== "string" || !UUID.test(body.userId) || !isPrincipalRole(body.role)) {
      throw new Error("invalid /v1/auth/me body")
    }
    return { kind: "ok", userId: body.userId, role: body.role }
  }
  if ((status === 401 && body.error === "unauthenticated") ||
      (status === 403 && (body.error === "identity_not_linked" || body.error === "forbidden"))) {
    return { kind: "rejected", status, error: body.error } as BackendMe
  }
  throw new Error("unexpected /v1/auth/me error body")
}

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE })

async function handleGet() {
  const verification = await verifySupabaseIdentity()
  if (!verification.ok) {
    log(verification.reason === "auth_unavailable" ? "warn" : "info", "AUTH_REJECTED", {
      subsystem: "auth",
      errorCode: verification.reason === "auth_unavailable" ? "AUTH_UNAVAILABLE" : verification.reason === "no_session" ? "AUTH_MISSING" : "AUTH_INVALID",
    })
    return verification.reason === "auth_unavailable"
      ? json({ error: "auth_unavailable" }, 503)
      : json({ error: "unauthenticated" }, 401)
  }

  let result: BackendMe
  try {
    ;({ data: result } = await backendGetJson({
      operation: "auth_me",
      path: "/v1/auth/me",
      requestId: currentRequestId(),
      identity: verification.identity,
      acceptStatuses: [401, 403],
      parse: parseBackendMe,
    }))
  } catch (error) {
    if (isBackendClientError(error)) return json({ error: "service_unavailable" }, 503)
    throw error
  }

  if (result.kind === "ok") return json({ authenticated: true, userId: result.userId, role: result.role }, 200)

  // The backend rejecting an assertion we just signed is OUR misconfiguration
  // (secret mismatch, clock skew), not the visitor's session: 503, logged.
  if (result.status === 401) {
    log("error", "AUTH_REJECTED", { subsystem: "auth", errorCode: "AUTH_UNAVAILABLE", reason: "assertion_rejected" })
    return json({ error: "service_unavailable" }, 503)
  }
  log("info", "AUTH_REJECTED", {
    subsystem: "auth",
    errorCode: result.error === "identity_not_linked" ? "IDENTITY_NOT_LINKED" : "AUTH_FORBIDDEN",
  })
  return json({ error: result.error }, 403)
}

export const GET = withObservability("GET /api/auth/backend-me", handleGet)

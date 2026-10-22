import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { InternalAuthConfigError, verifyAssertion } from "@/lib/identity/assertion"
import { DEFAULT_SESSION_POLICY, evaluateSessionPolicy } from "@/lib/identity/session-policy"
import type { AuthPrincipal, PrincipalRole } from "@/lib/identity/types"
import { logEvent } from "@/lib/observability/logger"
import { resolveUserIdentity } from "@/lib/repositories/user-identities"
import { consumeWriteNonce } from "@/lib/repositories/write-nonces"
import type { BackendDeps } from "../app"
import { routeLabel } from "./observability"

/**
 * Authentication for backend routes (V0.1.42).
 *
 * `requireAuth` is a preHandler: it reads ONLY the internal assertion header,
 * verifies it for this exact method + path, resolves the identity in
 * PostgreSQL, and sets `request.authPrincipal`. Routes read the principal and
 * nothing else to learn who is calling.
 *
 *   no assertion                         401 { error: "unauthenticated" }   AUTH_MISSING
 *   malformed/forged/expired/rebound     401 { error: "unauthenticated" }   AUTH_INVALID
 *   session older than 30 days           401 { error: "session_expired" }   SESSION_EXPIRED
 *   signed in before sessions_not_before 401 { error: "session_invalidated" } SESSION_INVALIDATED
 *   valid, identity not linked           403 { error: "identity_not_linked" } IDENTITY_NOT_LINKED
 *   linked, account deleted              403 { error: "forbidden" }         AUTH_FORBIDDEN
 *   role not allowed (requireRole)       403 { error: "forbidden" }         AUTH_FORBIDDEN
 *   secret missing / database down       503 { error: "service_unavailable" } AUTH_UNAVAILABLE
 *   (writes) nonce already consumed      409 { error: "replayed_request" }  NONCE_REPLAYED
 *
 * Logs carry the request id, the category and a coarse reason (never the
 * assertion, signature, subject, nonce or user id).
 *
 * `requireAuth` accepts ONLY a v2 assertion on GET/HEAD. Writes use
 * `requireWriteAuth` (V0.1.47), which accepts ONLY v3 and runs, in order:
 *
 *   1. header present, single                     401 unauthenticated
 *   2. MAC (constant time) -> version 3 -> claims -> not expired / not
 *      future -> method + path binding -> body digest over the RECEIVED bytes
 *                                                  401 unauthenticated
 *   3. identity (user_identities)                  403 identity_not_linked / forbidden (deleted)
 *   4. session policy (30 days, sessions_not_before) 401 session_expired / session_invalidated
 *   5. role                                         403 forbidden
 *   6. nonce: consume_internal_write_nonce()       409 replayed_request
 *   database down at 3 or 6                        503 service_unavailable
 *
 * The nonce is consumed LAST, after every check that does not change state:
 * nobody can burn a nonce without a fully valid assertion for an allowed
 * caller, and a request refused at 1-5 leaves its nonce unused (it was not
 * a write). Consumption is one atomic INSERT ... ON CONFLICT DO NOTHING, so
 * of N concurrent requests carrying the same assertion exactly one passes
 * this step and reaches the handler. It is a separate statement from the
 * write: if the write then fails, the nonce stays consumed and the client
 * must sign a new assertion (it never retries automatically anyway).
 */

declare module "fastify" {
  interface FastifyRequest {
    authPrincipal: AuthPrincipal | null
    /** The exact JSON body bytes as received (app.ts parser); null without a body. */
    rawBody: Buffer | null
  }
}

const HEADER = "x-cartoona-internal-auth"

function reject(
  request: FastifyRequest,
  reply: FastifyReply,
  status: 401 | 403 | 409 | 503,
  error: string,
  category: string,
  reason?: string,
) {
  logEvent(status === 503 ? "warn" : "info", "AUTH_REJECTED", {
    requestId: request.id,
    route: routeLabel(request),
    method: request.method,
    status,
    subsystem: "auth",
    errorCode: category,
    reason,
  })
  return reply.code(status).header("Cache-Control", "no-store").send({ error })
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest("authPrincipal", null)
  app.decorateRequest("rawBody", null)
}

type Verified = Extract<ReturnType<typeof verifyAssertion>, { ok: true }>["claims"]

/**
 * Steps shared by reads and writes: the header, the assertion for `kind`,
 * identity and the session policy. Returns the claims and principal, or
 * undefined after it has already sent the rejection.
 */
async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BackendDeps,
  kind: "read" | "write",
): Promise<{ claims: Verified; principal: AuthPrincipal } | undefined> {
  const header = request.headers[HEADER]
  if (header === undefined) {
    reject(request, reply, 401, "unauthenticated", "AUTH_MISSING")
    return
  }
  // A repeated header arrives as an array: ambiguous, so refused.
  if (typeof header !== "string") {
    reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", "malformed")
    return
  }

  let secret: Buffer
  try {
    secret = deps.authSecret()
  } catch (error) {
    if (error instanceof InternalAuthConfigError) {
      reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "config")
      return
    }
    throw error
  }

  const result = verifyAssertion({
    token: header,
    secret,
    method: request.method,
    path: request.url.split("?")[0],
    now: deps.now(),
    kind,
    // A write without a body (no Content-Type) is the digest of zero bytes.
    ...(kind === "write" ? { body: request.rawBody ?? Buffer.alloc(0) } : {}),
  })
  if (!result.ok) {
    reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", result.reason)
    return
  }

  let identity
    try {
      identity = await resolveUserIdentity(deps.db(), {
        provider: result.claims.provider,
        providerSubject: result.claims.subject,
      })
    } catch (error) {
    if (error instanceof DbError || error instanceof DbConfigError) {
      reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "database")
      return
    }
    throw error
  }

  if (!identity) {
    reject(request, reply, 403, "identity_not_linked", "IDENTITY_NOT_LINKED")
    return
  }
  if (identity.deleted) {
    reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "account_deleted")
    return
  }

  // Cartoona's session policy (V0.1.43), on the provider-verified sign-in
  // time the assertion carries and this user's sessions_not_before - both
  // already in hand, so no extra query.
  const decision = evaluateSessionPolicy(
    { authenticatedAt: result.claims.authenticatedAt },
    { ...DEFAULT_SESSION_POLICY, sessionsNotBefore: identity.sessionsNotBefore },
    deps.now(),
  )
  if (decision.status === "invalidated") {
    reject(request, reply, 401, "session_invalidated", "SESSION_INVALIDATED")
    return
  }
  if (decision.status === "expired") {
    reject(request, reply, 401, "session_expired", "SESSION_EXPIRED")
    return
  }
  if (decision.status !== "valid") {
    reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", "session_evidence")
    return
  }

  return { claims: result.claims, principal: { userId: identity.userId, role: identity.role } }
}

/** READ routes (GET/HEAD): a v2 assertion only. A v3 (write) assertion is refused here. */
export function requireAuth(deps: BackendDeps): preHandlerAsyncHookHandler {
  return async function authenticateRead(request, reply) {
    const verified = await authenticate(request, reply, deps, "read")
    if (!verified) return reply
    request.authPrincipal = verified.principal
    logEvent("debug", "AUTH_VERIFIED", { requestId: request.id, subsystem: "auth", userRole: verified.principal.role })
  }
}

/**
 * WRITE routes (POST/PUT/PATCH/DELETE), V0.1.47: a v3 assertion bound to
 * this method, path and the received body bytes, a caller with one of
 * `roles`, and a nonce never seen before - consumed here, last. The one
 * preHandler a write route needs; there is no way to authenticate a write
 * without consuming its nonce. See the order at the top of this file.
 */
export function requireWriteAuth(deps: BackendDeps, ...roles: PrincipalRole[]): preHandlerAsyncHookHandler {
  if (roles.length === 0) throw new TypeError("requireWriteAuth: at least one role")
  return async function authenticateWrite(request, reply) {
    const verified = await authenticate(request, reply, deps, "write")
    if (!verified) return reply
    if (!roles.includes(verified.principal.role)) return reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "role")

    let consumed: boolean
    try {
      consumed = await consumeWriteNonce(deps.db(), {
        nonce: verified.claims.nonce!,
        expiresAtSeconds: verified.claims.expiresAt,
        requestId: verified.claims.requestId,
      })
    } catch (error) {
      if (error instanceof DbError || error instanceof DbConfigError) {
        return reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "nonce_store")
      }
      throw error
    }
    if (!consumed) return reject(request, reply, 409, "replayed_request", "NONCE_REPLAYED")

    request.authPrincipal = verified.principal
    logEvent("debug", "AUTH_VERIFIED", { requestId: request.id, subsystem: "auth", userRole: verified.principal.role })
  }
}

/** Use after requireAuth: 403 unless the principal has one of `roles`. */
export function requireRole(...roles: PrincipalRole[]): preHandlerAsyncHookHandler {
  return async function authorize(request, reply) {
    const principal = request.authPrincipal
    if (!principal) return reject(request, reply, 401, "unauthenticated", "AUTH_MISSING")
    if (!roles.includes(principal.role)) return reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "role")
  }
}

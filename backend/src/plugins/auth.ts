import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { InternalAuthConfigError, verifyAssertion, verifyServiceAssertion, type InternalService } from "@/lib/identity/assertion"
import { DEFAULT_SESSION_POLICY, evaluateSessionPolicy } from "@/lib/identity/session-policy"
import type { AuthPrincipal, PrincipalRole } from "@/lib/identity/types"
import { logEvent } from "@/lib/observability/logger"
import { resolveUserIdentity, type ResolvedUserIdentity } from "@/lib/repositories/user-identities"
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
    /** Verified provider subject, set ONLY by requireProvisioningAuth (V0.1.49). */
    provisioningSubject: string | null
    /** The internal service a verified s1 assertion named, set ONLY by requireServiceAuth (V0.1.51). */
    serviceCaller: InternalService | null
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
  app.decorateRequest("provisioningSubject", null)
  app.decorateRequest("serviceCaller", null)
}

type Verified = Extract<ReturnType<typeof verifyAssertion>, { ok: true }>["claims"]

/**
 * Steps 1-2: the header and the assertion for `kind` (a write's body digest
 * over the received bytes). Returns the claims, or undefined after it has
 * already sent the rejection. Nothing is looked up yet.
 */
/** Step 1 for every kind (identity read/write, service): the one header and the key. Undefined after a rejection. */
function headerAndSecret(request: FastifyRequest, reply: FastifyReply, deps: BackendDeps): { header: string; secret: Buffer } | undefined {
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
  try {
    return { header, secret: deps.authSecret() }
  } catch (error) {
    if (error instanceof InternalAuthConfigError) {
      reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "config")
      return
    }
    throw error
  }
}

async function verifyRequestAssertion(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BackendDeps,
  kind: "read" | "write",
): Promise<Verified | undefined> {
  const hs = headerAndSecret(request, reply, deps)
  if (!hs) return
  const { header, secret } = hs

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
  return result.claims
}

/** Step 3 lookup; null = not linked. Undefined after a 503 has been sent. */
async function lookUpIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BackendDeps,
  claims: Verified,
): Promise<ResolvedUserIdentity | null | undefined> {
  try {
    return await resolveUserIdentity(deps.db(), { provider: claims.provider, providerSubject: claims.subject })
  } catch (error) {
    if (error instanceof DbError || error instanceof DbConfigError) {
      reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "database")
      return
    }
    throw error
  }
}

/**
 * Step 4: Cartoona's session policy (V0.1.43), on the provider-verified
 * sign-in time the assertion carries and this user's sessions_not_before -
 * both already in hand, so no extra query. False after the rejection is sent.
 */
function sessionAllowed(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BackendDeps,
  claims: Verified,
  sessionsNotBefore: number | null,
): boolean {
  const decision = evaluateSessionPolicy(
    { authenticatedAt: claims.authenticatedAt },
    { ...DEFAULT_SESSION_POLICY, sessionsNotBefore },
    deps.now(),
  )
  if (decision.status === "valid") return true
  if (decision.status === "invalidated") reject(request, reply, 401, "session_invalidated", "SESSION_INVALIDATED")
  else if (decision.status === "expired") reject(request, reply, 401, "session_expired", "SESSION_EXPIRED")
  else reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", "session_evidence")
  return false
}

/** Step 6: consume the write's nonce, last. False after the rejection is sent. */
async function nonceConsumed(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BackendDeps,
  claims: { nonce?: string; expiresAt: number; requestId: string },
): Promise<boolean> {
  let consumed: boolean
  try {
    consumed = await consumeWriteNonce(deps.db(), {
      nonce: claims.nonce!,
      expiresAtSeconds: claims.expiresAt,
      requestId: claims.requestId,
    })
  } catch (error) {
    if (error instanceof DbError || error instanceof DbConfigError) {
      reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "nonce_store")
      return false
    }
    throw error
  }
  if (!consumed) reject(request, reply, 409, "replayed_request", "NONCE_REPLAYED")
  return consumed
}

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
  const claims = await verifyRequestAssertion(request, reply, deps, kind)
  if (!claims) return

  const identity = await lookUpIdentity(request, reply, deps, claims)
  if (identity === undefined) return
  if (!identity) {
    reject(request, reply, 403, "identity_not_linked", "IDENTITY_NOT_LINKED")
    return
  }
  if (identity.deleted) {
    reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "account_deleted")
    return
  }
  if (!sessionAllowed(request, reply, deps, claims, identity.sessionsNotBefore)) return

  return { claims, principal: { userId: identity.userId, role: identity.role } }
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
    if (!(await nonceConsumed(request, reply, deps, verified.claims))) return reply

    request.authPrincipal = verified.principal
    logEvent("debug", "AUTH_VERIFIED", { requestId: request.id, subsystem: "auth", userRole: verified.principal.role })
  }
}

/**
 * The ONE preHandler for POST /v1/auth/provision (V0.1.49). It is
 * requireWriteAuth(deps, "parent") with a single difference: an identity
 * that is NOT linked yet is allowed through (creating it is the route's job).
 *
 *   1-2. header, v3 assertion: MAC, expiry, method + path, body digest   401
 *   3.   identity lookup                                                 503 on database failure
 *        linked + deleted                                                403 forbidden
 *        linked + not a parent                                           403 forbidden
 *   4.   session policy: 30 days always; sessions_not_before when linked 401
 *   6.   nonce, last                                                     409 / 503
 *
 * Sets `request.provisioningSubject` (the verified subject) and NOT
 * `authPrincipal`: there may be no Cartoona user yet. The provider is the
 * assertion's, which only accepts "supabase" today. Nothing from the body,
 * query or other headers names the account.
 */
export function requireProvisioningAuth(deps: BackendDeps): preHandlerAsyncHookHandler {
  return async function authenticateProvisioning(request, reply) {
    const claims = await verifyRequestAssertion(request, reply, deps, "write")
    if (!claims) return reply

    const identity = await lookUpIdentity(request, reply, deps, claims)
    if (identity === undefined) return reply
    if (identity?.deleted) return reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "account_deleted")
    if (identity && identity.role !== "parent") return reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "role")
    if (!sessionAllowed(request, reply, deps, claims, identity?.sessionsNotBefore ?? null)) return reply
    if (!(await nonceConsumed(request, reply, deps, claims))) return reply

    request.provisioningSubject = claims.subject
    logEvent("debug", "AUTH_VERIFIED", { requestId: request.id, subsystem: "auth", reason: identity ? "linked" : "not_linked" })
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

/**
 * PROVIDER-AUTHENTICATED internal writes (V0.1.51): a service assertion (s1)
 * for exactly `service`, bound to method, path and the received body, then its
 * nonce consumed LAST (same store and same 409 as v3). No identity, no session
 * policy, no role: there is no parent behind a payment event. Identity (v2/v3)
 * tokens are refused here and s1 tokens are refused by every identity route.
 *
 *   no header / malformed / forged / expired / rebound / other service   401 unauthenticated
 *   secret missing                                                        503 service_unavailable
 *   nonce replayed                                                        409 replayed_request
 */
export function requireServiceAuth(deps: BackendDeps, service: InternalService): preHandlerAsyncHookHandler {
  return async function authenticateService(request, reply) {
    const hs = headerAndSecret(request, reply, deps)
    if (!hs) return reply
    const result = verifyServiceAssertion({
      token: hs.header,
      secret: hs.secret,
      method: request.method,
      path: request.url.split("?")[0],
      body: request.rawBody ?? Buffer.alloc(0),
      now: deps.now(),
    })
    if (!result.ok) return reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", result.reason)
    if (result.claims.service !== service) return reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", "service")
    if (!(await nonceConsumed(request, reply, deps, result.claims))) return reply
    request.serviceCaller = service
    logEvent("debug", "AUTH_VERIFIED", { requestId: request.id, subsystem: "auth", reason: "service" })
  }
}

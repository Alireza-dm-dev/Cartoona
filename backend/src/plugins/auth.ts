import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { InternalAuthConfigError, verifyAssertion } from "@/lib/identity/assertion"
import type { AuthPrincipal, PrincipalRole } from "@/lib/identity/types"
import { logEvent } from "@/lib/observability/logger"
import { resolveUserIdentity } from "@/lib/repositories/user-identities"
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
 *   valid, identity not linked           403 { error: "identity_not_linked" } IDENTITY_NOT_LINKED
 *   linked, account deleted              403 { error: "forbidden" }         AUTH_FORBIDDEN
 *   role not allowed (requireRole)       403 { error: "forbidden" }         AUTH_FORBIDDEN
 *   secret missing / database down       503 { error: "service_unavailable" } AUTH_UNAVAILABLE
 *
 * Logs carry the request id, the category and a coarse reason (never the
 * assertion, signature, subject or user id).
 */

declare module "fastify" {
  interface FastifyRequest {
    authPrincipal: AuthPrincipal | null
  }
}

const HEADER = "x-cartoona-internal-auth"

function reject(
  request: FastifyRequest,
  reply: FastifyReply,
  status: 401 | 403 | 503,
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
}

export function requireAuth(deps: BackendDeps): preHandlerAsyncHookHandler {
  return async function authenticate(request, reply) {
    const header = request.headers[HEADER]
    if (header === undefined) return reject(request, reply, 401, "unauthenticated", "AUTH_MISSING")
    // A repeated header arrives as an array: ambiguous, so refused.
    if (typeof header !== "string") return reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", "malformed")

    let secret: Buffer
    try {
      secret = deps.authSecret()
    } catch (error) {
      if (error instanceof InternalAuthConfigError) {
        return reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "config")
      }
      throw error
    }

    const result = verifyAssertion({
      token: header,
      secret,
      method: request.method,
      path: request.url.split("?")[0],
    })
    if (!result.ok) return reject(request, reply, 401, "unauthenticated", "AUTH_INVALID", result.reason)

    let identity
    try {
      identity = await resolveUserIdentity(deps.db(), {
        provider: result.claims.provider,
        providerSubject: result.claims.subject,
      })
    } catch (error) {
      if (error instanceof DbError || error instanceof DbConfigError) {
        return reject(request, reply, 503, "service_unavailable", "AUTH_UNAVAILABLE", "database")
      }
      throw error
    }

    if (!identity) return reject(request, reply, 403, "identity_not_linked", "IDENTITY_NOT_LINKED")
    if (identity.deleted) return reject(request, reply, 403, "forbidden", "AUTH_FORBIDDEN", "account_deleted")

    request.authPrincipal = { userId: identity.userId, role: identity.role }
    logEvent("debug", "AUTH_VERIFIED", { requestId: request.id, subsystem: "auth", userRole: identity.role })
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

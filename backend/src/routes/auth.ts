import type { FastifyInstance } from "fastify"
import type { BackendDeps } from "../app"
import { requireAuth } from "../plugins/auth"

/**
 * GET /v1/auth/me - proof of the authenticated chain (V0.1.42).
 *
 * Returns only who the backend resolved the caller to: the Cartoona user id
 * and the role from `public.users`. No email, phone, names, profile data,
 * provider subject or tokens. Every failure is the fixed body from requireAuth.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get("/v1/auth/me", { preHandler: requireAuth(deps) }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const principal = request.authPrincipal!
    return { authenticated: true, userId: principal.userId, role: principal.role }
  })
}

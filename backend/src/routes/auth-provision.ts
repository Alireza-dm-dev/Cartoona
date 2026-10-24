import type { FastifyInstance, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { PROVISIONED_OUTCOMES, provisionSupabaseParent } from "@/lib/repositories/user-provisioning"
import type { BackendDeps } from "../app"
import { requireProvisioningAuth } from "../plugins/auth"

/**
 * POST /v1/auth/provision (V0.1.49) - make sure the signed-in Supabase parent
 * exists in Cartoona's PostgreSQL before any migrated parent route needs it.
 *
 *   v3 write assertion (body digest + nonce), requireProvisioningAuth: the
 *   identity does NOT have to be linked yet - that is the point of this route.
 *   body exactly {}; no query string.
 *
 *   200 { provisioned: true }            created now, or already complete
 *   400 { error: "invalid_request" }     any query, or a body other than {}
 *   401 / 403 / 409 / 503                requireProvisioningAuth
 *   403 { error: "forbidden" }           soft-deleted account, or not a parent
 *   409 { error: "identity_conflict" }   the subject / user is bound elsewhere:
 *                                         never remapped, needs an operator
 *   503 { error: "service_unavailable" } database failure; nothing half-written
 *
 * The response carries no user id, profile id, role or outcome detail: the
 * caller (the Next BFF) only needs "ready or not". The ONLY input is the
 * verified subject the preHandler put on the request. Nothing here retries;
 * a later call is safe because provisioning is idempotent (a lost response
 * is resolved by calling again with a new assertion).
 */

export const PROVISION_PATH = "/v1/auth/provision"

function hasQuery(request: FastifyRequest): boolean {
  return Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0
}

export function registerAuthProvisionRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.post(PROVISION_PATH, { preHandler: [requireProvisioningAuth(deps)] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "parent_provision"
    const rejected = (status: 400 | 403 | 409, error: string, reason: string) => {
      logEvent("info", "PROVISION_REJECTED", { requestId: request.id, operation, reason })
      return reply.code(status).send({ error })
    }
    if (hasQuery(request)) return rejected(400, "invalid_request", "query")
    const body = request.body
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
      return rejected(400, "invalid_request", "body")
    }

    let outcome
    try {
      outcome = await provisionSupabaseParent(deps.db(), { providerSubject: request.provisioningSubject! })
    } catch (error) {
      if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
      logEvent("warn", "PROVISION_FAILED", {
        requestId: request.id,
        operation,
        subsystem: "database",
        errorCode: "DATABASE_UNAVAILABLE",
        reason: error instanceof DbError ? error.kind : "config",
      })
      return reply.code(503).send({ error: "service_unavailable" })
    }

    if (outcome === "identity_conflict") {
      // An operator must look: the identity is bound to another account.
      logEvent("error", "PROVISION_REJECTED", { requestId: request.id, operation, reason: outcome })
      return reply.code(409).send({ error: "identity_conflict" })
    }
    if (!PROVISIONED_OUTCOMES.has(outcome)) return rejected(403, "forbidden", outcome)

    logEvent("info", "PROVISION_COMPLETED", { requestId: request.id, operation, reason: outcome })
    return { provisioned: true }
  })
}

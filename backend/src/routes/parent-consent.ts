import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { getParentConsentState, recordParentConsent } from "@/lib/repositories/parent-profiles"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * The signed-in parent's CONSENT (V0.1.48): the first real product write on
 * the new architecture, and the read every consent gate now uses.
 *
 *   GET  /v1/parent/consent   v2 read assertion, parent only
 *     200 { consentGranted: boolean, consentGrantedAt: string | null }
 *   POST /v1/parent/consent   v3 write assertion (body digest + nonce), parent only
 *     body exactly { consentGranted: true }   (consent is one-way; there is no revoke)
 *     200 { consentGranted: true, consentGrantedAt: string }   the STORED state
 *
 *   400 { error: "invalid_request" }            any query string; on POST any other body
 *   401 / 403 / 409 / 503                        requireAuth+requireRole / requireWriteAuth
 *   404 { error: "parent_profile_not_found" }    no profile: nothing read, nothing written
 *   503 { error: "service_unavailable" }         database failure
 *
 * The caller is ONLY `request.authPrincipal`: no user or profile id is taken
 * from the query, a header or the body (a body with any key but
 * consentGranted is a 400). The write runs record_parent_consent_trusted
 * (migration 0014), the one consent privilege the app role has.
 *
 * Retry semantics: granting twice ends in the same state and keeps the first
 * grant's time, so a user retry after an uncertain outcome (new assertion,
 * new nonce) is safe. A replay of the SAME assertion is refused 409 by its
 * nonce before this handler runs. Nothing here retries. Every response is
 * Cache-Control: no-store.
 */

export const CONSENT_PATH = "/v1/parent/consent"

function hasQuery(request: FastifyRequest): boolean {
  return Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0
}

function databaseFailure(request: FastifyRequest, reply: FastifyReply, event: string, operation: string, error: unknown) {
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", event, {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

export function registerParentConsentRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get(CONSENT_PATH, { preHandler: [requireAuth(deps), requireRole("parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "parent_consent"
    if (hasQuery(request)) {
      logEvent("info", "CONSENT_READ_REJECTED", { requestId: request.id, operation, reason: "invalid_request" })
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const state = await getParentConsentState(deps.db(), { userId: request.authPrincipal!.userId })
      if (!state) {
        logEvent("info", "CONSENT_READ_REJECTED", { requestId: request.id, operation, reason: "no_parent_profile" })
        return reply.code(404).send({ error: "parent_profile_not_found" })
      }
      return { consentGranted: state.consentGranted, consentGrantedAt: state.consentGrantedAt }
    } catch (error) {
      return databaseFailure(request, reply, "CONSENT_READ_FAILED", operation, error)
    }
  })

  app.post(CONSENT_PATH, { preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "parent_consent_grant"
    const invalid = (reason: string) => {
      logEvent("info", "CONSENT_WRITE_REJECTED", { requestId: request.id, operation, reason })
      return reply.code(400).send({ error: "invalid_request" })
    }
    if (hasQuery(request)) return invalid("query")
    const body = request.body
    if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("body")
    const keys = Object.keys(body)
    if (keys.length !== 1 || keys[0] !== "consentGranted") return invalid("keys")
    if ((body as { consentGranted: unknown }).consentGranted !== true) return invalid("value")

    try {
      const state = await recordParentConsent(deps.db(), { userId: request.authPrincipal!.userId })
      if (!state) {
        logEvent("info", "CONSENT_WRITE_REJECTED", { requestId: request.id, operation, reason: "no_parent_profile" })
        return reply.code(404).send({ error: "parent_profile_not_found" })
      }
      logEvent("info", "CONSENT_WRITE_COMPLETED", { requestId: request.id, operation })
      return { consentGranted: state.consentGranted, consentGrantedAt: state.consentGrantedAt }
    } catch (error) {
      return databaseFailure(request, reply, "CONSENT_WRITE_FAILED", operation, error)
    }
  })
}

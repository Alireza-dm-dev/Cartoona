import type { FastifyInstance } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { parseOrdersListQuery } from "@/lib/parent/orders/list-query"
import { getParentOrdersPage } from "@/lib/repositories/parent-orders"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole } from "../plugins/auth"

/**
 * GET /v1/parent/orders?cursor=&limit= - the signed-in parent's orders LIST
 * (V0.1.45). Read-only.
 *
 * Caller: ONLY `request.authPrincipal` from requireAuth (the internal
 * assertion). Nothing else names the caller: no query, body, header, cookie or
 * bearer token is read for identity, and any query parameter other than
 * cursor/limit (e.g. parentProfileId) is a 400.
 *
 *   principal.userId -> parent_profiles.id (findParentProfileIdByUserId)
 *                    -> getParentOrdersPage(profile)   [WHERE parent_id = $1]
 *
 *   200 { orders: ParentOrderSummary[], nextCursor: string | null }
 *   400 { error: "invalid_request" }            bad cursor/limit or unknown parameter
 *   401 / 403 / 503                               requireAuth / requireRole (parent only)
 *   404 { error: "parent_profile_not_found" }    a parent account with no profile yet
 *   503 { error: "service_unavailable" }         database failure
 *
 * Every response is Cache-Control: no-store. No profile id, user id or
 * internal column is ever returned; DB errors are logged by category only.
 */

export function registerParentOrdersRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get(
    "/v1/parent/orders",
    { preHandler: [requireAuth(deps), requireRole("parent")] },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const parsed = parseOrdersListQuery((request.query ?? {}) as Record<string, unknown>, { rejectUnknown: true })
      if (!parsed.ok) {
        logEvent("info", "ORDERS_PAGE_REJECTED", { requestId: request.id, reason: "invalid_request" })
        return reply.code(400).send({ error: "invalid_request" })
      }
      const userId = request.authPrincipal!.userId

      try {
        const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId })
        if (!parentProfileId) {
          logEvent("info", "ORDERS_PAGE_REJECTED", { requestId: request.id, reason: "no_parent_profile" })
          return reply.code(404).send({ error: "parent_profile_not_found" })
        }
        const page = await getParentOrdersPage(deps.db(), { parentProfileId }, {
          cursor: parsed.query.cursor,
          limit: parsed.query.limit ?? undefined,
        })
        if (!page.ok) return reply.code(400).send({ error: "invalid_request" })
        return { orders: page.orders, nextCursor: page.nextCursor }
      } catch (error) {
        if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
        logEvent("warn", "ORDERS_PAGE_FAILED", {
          requestId: request.id,
          subsystem: "database",
          errorCode: "DATABASE_UNAVAILABLE",
          reason: error instanceof DbError ? error.kind : "config",
        })
        return reply.code(503).send({ error: "service_unavailable" })
      }
    },
  )
}

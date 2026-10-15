import type { FastifyInstance } from "fastify"
import { DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { getActiveCreationPrices } from "@/lib/repositories/creation-pricing"
import type { BackendDeps } from "../app"

/**
 * GET /v1/creation-pricing - public, read-only, from PostgreSQL.
 *
 * The same contract as the Next route GET /api/creation-pricing (which still
 * reads Supabase and is untouched):
 *   200 { prices: { "<pricing_key>": <candy_cost>, ... } }
 *       Cache-Control: public, s-maxage=60, stale-while-revalidate=300
 *   503 { error: "<Persian message>", code: "CREATION_PRICING_UNAVAILABLE" }
 *       Cache-Control: no-store
 * for a database failure and for an invalid or empty catalog alike, so a
 * client written against one works unchanged against the other.
 */

export const PRICING_UNAVAILABLE_BODY = {
  error: "قیمت‌ها در حال حاضر در دسترس نیستند.",
  code: "CREATION_PRICING_UNAVAILABLE",
} as const

export function registerCreationPricingRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get("/v1/creation-pricing", async (request, reply) => {
    let result
    try {
      result = await getActiveCreationPrices(deps.db())
    } catch (error) {
      if (!(error instanceof DbError)) throw error
      logEvent("warn", "PRICING_UNAVAILABLE", {
        requestId: request.id,
        subsystem: "database",
        errorCode: "DATABASE_UNAVAILABLE",
        reason: error.kind,
      })
      return reply.code(503).header("Cache-Control", "no-store").send(PRICING_UNAVAILABLE_BODY)
    }

    if (!result.ok) {
      logEvent("error", "PRICING_UNAVAILABLE", { requestId: request.id, subsystem: "database", reason: result.reason })
      return reply.code(503).header("Cache-Control", "no-store").send(PRICING_UNAVAILABLE_BODY)
    }

    reply.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300")
    return { prices: result.prices }
  })
}

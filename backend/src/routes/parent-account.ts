import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { getCandyBalance } from "@/lib/repositories/candy-wallets"
import { findParentProfileIdByUserId, getParentProfileDisplay } from "@/lib/repositories/parent-profiles"
import { getWelcomeImageCreditsRemaining } from "@/lib/repositories/welcome-credits"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole } from "../plugins/auth"

/**
 * The signed-in parent's account READS (V0.1.46). Read-only, GET only.
 *
 *   GET /v1/parent/profile          200 { fullName: string | null }
 *   GET /v1/parent/candy-balance    200 { balance: number }        no wallet row -> 0
 *   GET /v1/parent/welcome-credits  200 { welcomeImageCreditsRemaining: number }
 *
 * Caller: ONLY `request.authPrincipal` from requireAuth (the internal
 * assertion). None of these routes takes a parameter: any query string (e.g.
 * parentProfileId) is a 400, and no header, body or cookie is read for
 * identity. The profile is resolved here from principal.userId, so a parent
 * can only ever read their own row.
 *
 *   400 { error: "invalid_request" }            any query parameter
 *   401 / 403 / 503                               requireAuth / requireRole (parent only)
 *   404 { error: "parent_profile_not_found" }    a parent account with no profile yet
 *   503 { error: "service_unavailable" }         database failure
 *
 * Every response is Cache-Control: no-store. No profile id, user id, ledger or
 * usage row, consent flag or referral code is returned; DB errors are logged
 * by category only.
 */

type Read = (deps: BackendDeps, userId: string) => Promise<Record<string, unknown> | null>

const READS: Record<string, { operation: string; read: Read }> = {
  "/v1/parent/profile": {
    operation: "parent_profile",
    read: async (deps, userId) => getParentProfileDisplay(deps.db(), { userId }),
  },
  "/v1/parent/candy-balance": {
    operation: "parent_candy_balance",
    read: async (deps, userId) => {
      const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId })
      if (!parentProfileId) return null
      // No wallet row reads as 0, the value the billing page has always shown.
      return { balance: (await getCandyBalance(deps.db(), { parentProfileId })) ?? 0 }
    },
  },
  "/v1/parent/welcome-credits": {
    operation: "parent_welcome_credits",
    read: async (deps, userId) => {
      const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId })
      if (!parentProfileId) return null
      return { welcomeImageCreditsRemaining: await getWelcomeImageCreditsRemaining(deps.db(), { parentProfileId }) }
    },
  },
}

export function registerParentAccountRoutes(app: FastifyInstance, deps: BackendDeps): void {
  for (const [path, { operation, read }] of Object.entries(READS)) {
    app.get(path, { preHandler: [requireAuth(deps), requireRole("parent")] }, (request, reply) =>
      handle(request, reply, deps, operation, read),
    )
  }
}

async function handle(request: FastifyRequest, reply: FastifyReply, deps: BackendDeps, operation: string, read: Read) {
  reply.header("Cache-Control", "no-store")
  if (Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0) {
    logEvent("info", "ACCOUNT_READ_REJECTED", { requestId: request.id, operation, reason: "invalid_request" })
    return reply.code(400).send({ error: "invalid_request" })
  }
  const userId = request.authPrincipal!.userId

  try {
    const body = await read(deps, userId)
    if (!body) {
      logEvent("info", "ACCOUNT_READ_REJECTED", { requestId: request.id, operation, reason: "no_parent_profile" })
      return reply.code(404).send({ error: "parent_profile_not_found" })
    }
    return body
  } catch (error) {
    if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
    logEvent("warn", "ACCOUNT_READ_FAILED", {
      requestId: request.id,
      operation,
      subsystem: "database",
      errorCode: "DATABASE_UNAVAILABLE",
      reason: error instanceof DbError ? error.kind : "config",
    })
    return reply.code(503).send({ error: "service_unavailable" })
  }
}

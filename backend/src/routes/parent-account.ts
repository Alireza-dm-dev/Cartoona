import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { getCandyBalance } from "@/lib/repositories/candy-wallets"
import { checkParentName } from "@/lib/parent/profile-name"
import { findParentProfileIdByUserId, getParentProfileDisplay, updateParentProfileName } from "@/lib/repositories/parent-profiles"
import { getWelcomeImageCreditsRemaining } from "@/lib/repositories/welcome-credits"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

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
 *
 * And the first WRITE (V0.1.47), proven at the backend only - no Next route or
 * UI calls it yet:
 *
 *   PATCH /v1/parent/profile   body exactly { fullName: string | null }
 *     200 { fullName: string | null }              the stored (normalized) value
 *     400 { error: "invalid_request" }             query string, other keys, bad name
 *     401 / 403 / 409 / 503                        requireWriteAuth (v3, parent, nonce)
 *     404 { error: "parent_profile_not_found" }    nothing written
 *     503 { error: "service_unavailable" }         database failure
 *
 * The row is chosen by principal.userId inside the UPDATE's WHERE; a
 * parentProfileId, userId or any other key in the body is a 400, never used.
 * Setting the same name twice ends in the same state, so a user retry after an
 * uncertain timeout (new assertion, new nonce) is safe; a replay of the SAME
 * assertion is refused 409 by its nonce before reaching this handler.
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
  registerProfileWrite(app, deps)
}

const PROFILE_PATH = "/v1/parent/profile"

function registerProfileWrite(app: FastifyInstance, deps: BackendDeps): void {
  app.patch(PROFILE_PATH, { preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "parent_profile_update"
    const invalid = (reason: string) => {
      logEvent("info", "ACCOUNT_WRITE_REJECTED", { requestId: request.id, operation, reason })
      return reply.code(400).send({ error: "invalid_request" })
    }
    if (Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0) return invalid("query")
    const body = request.body
    if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("body")
    const keys = Object.keys(body)
    if (keys.length !== 1 || keys[0] !== "fullName") return invalid("keys")
    const name = checkParentName((body as { fullName: unknown }).fullName)
    if (!name.ok) return invalid(name.reason)

    try {
      const updated = await updateParentProfileName(deps.db(), { userId: request.authPrincipal!.userId, fullName: name.value })
      if (!updated) {
        logEvent("info", "ACCOUNT_WRITE_REJECTED", { requestId: request.id, operation, reason: "no_parent_profile" })
        return reply.code(404).send({ error: "parent_profile_not_found" })
      }
      logEvent("info", "ACCOUNT_WRITE_COMPLETED", { requestId: request.id, operation })
      return updated
    } catch (error) {
      if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
      logEvent("warn", "ACCOUNT_WRITE_FAILED", {
        requestId: request.id,
        operation,
        subsystem: "database",
        errorCode: "DATABASE_UNAVAILABLE",
        reason: error instanceof DbError ? error.kind : "config",
      })
      return reply.code(503).send({ error: "service_unavailable" })
    }
  })
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

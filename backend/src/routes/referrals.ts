import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import {
  bindParentReferralCode,
  getAdminReferralOverview,
  getParentReferralSummary,
  listAdminReferralRelationships,
  updateReferralProgramSettings,
} from "@/lib/repositories/referrals"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * REFERRALS (V0.1.53): the summary, the one-time code binding and the program
 * settings, all in PostgreSQL.
 *
 *   GET   /v1/parent/referrals                     v2, parent         the caller's code, program, binding, referred count
 *   POST  /v1/parent/referrals/bind  { code }      v3, parent         one-time binding (function: self/unknown/invalid -> invalid_code)
 *   GET   /v1/admin/referrals?search&page&pageSize v2, admin          overview + one page of relationships
 *   PATCH /v1/admin/referrals/settings             v3, admin          { isEnabled, rewardBasisPoints, expectedUpdatedAt }
 *
 * The caller is ONLY `request.authPrincipal`. The browser can supply the code to
 * bind and nothing else: no referrer id, no relationship id, no reward amount
 * (the schema has no reward balance; the basis points are program config that
 * only an admin changes, with optimistic concurrency and an immutable history
 * row). The functions lock the profile / settings row, so a concurrent double
 * bind and a concurrent settings write each resolve to one outcome. Statuses
 * from the function come back as `{ status }`; the Next route maps the Persian
 * text. Every answer is no-store; database failures are 503, category-only logs.
 */

const CODE_MAX = 100
const SMALL_BODY_LIMIT = 2048
const SEARCH_MAX = 100

function dbFailure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", "REFERRAL_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return fallback
  const n = Number(value)
  return n >= 1 ? n : fallback
}

export function registerReferralRoutes(app: FastifyInstance, deps: BackendDeps): void {
  const parentRead = { preHandler: [requireAuth(deps), requireRole("parent")] }
  const adminRead = { preHandler: [requireAuth(deps), requireRole("admin", "super_admin")] }

  app.get("/v1/parent/referrals", parentRead, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (Object.keys((request.query ?? {}) as object).length > 0) return reply.code(400).send({ error: "invalid_request" })
    try {
      const row = await getParentReferralSummary(deps.db(), { userId: request.authPrincipal!.userId })
      if (!row) return reply.code(404).send({ error: "referral_unavailable" })
      return {
        referralCode: row.referral_code,
        isEnabled: row.is_enabled,
        rewardBasisPoints: row.reward_basis_points,
        isBound: row.is_bound,
        boundAt: row.bound_at,
        referredCount: Number(row.referred_count),
      }
    } catch (error) {
      return dbFailure(request, reply, "referral_summary", error)
    }
  })

  app.post("/v1/parent/referrals/bind", { bodyLimit: SMALL_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const body = request.body as Record<string, unknown> | null
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
        typeof body.code !== "string" || body.code.trim().length === 0 || body.code.length > CODE_MAX) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const row = await bindParentReferralCode(deps.db(), { userId: request.authPrincipal!.userId, code: body.code })
      logEvent("info", "REFERRAL_BIND_ANSWERED", { requestId: request.id, operation: "referral_bind", reason: row.status })
      return { status: row.status, boundAt: row.bound_at }
    } catch (error) {
      return dbFailure(request, reply, "referral_bind", error)
    }
  })

  app.get("/v1/admin/referrals", adminRead, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const q = (request.query ?? {}) as Record<string, unknown>
    if (Object.keys(q).some((k) => k !== "search" && k !== "page" && k !== "pageSize")) return reply.code(400).send({ error: "invalid_request" })
    let search: string | null = null
    if (q.search !== undefined) {
      if (typeof q.search !== "string" || q.search.length > SEARCH_MAX) return reply.code(400).send({ error: "invalid_request" })
      search = q.search.trim() === "" ? null : q.search
    }
    const page = positiveInt(q.page, 1)
    const pageSize = Math.min(positiveInt(q.pageSize, 25), 50)
    const adminUserId = request.authPrincipal!.userId
    try {
      const [overview, rows] = await Promise.all([
        getAdminReferralOverview(deps.db(), { adminUserId }),
        listAdminReferralRelationships(deps.db(), { adminUserId, search, limit: pageSize, offset: (page - 1) * pageSize }),
      ])
      if (!overview) return reply.code(403).send({ error: "forbidden" })
      return {
        overview: {
          isEnabled: overview.is_enabled,
          rewardBasisPoints: overview.reward_basis_points,
          settingsUpdatedAt: overview.settings_updated_at,
          totalParentProfiles: Number(overview.total_parent_profiles),
          totalRelationships: Number(overview.total_referral_relationships),
          totalUnboundParentProfiles: Number(overview.total_unbound_parent_profiles),
          totalDeletedIdentityRelationships: Number(overview.total_deleted_identity_relationships),
          settingsHistoryCount: Number(overview.settings_history_count),
        },
        relationships: rows.map((r) => ({
          id: r.relationship_id,
          boundAt: r.bound_at,
          bindingSource: r.binding_source,
          referralCodeSnapshot: r.referral_code_snapshot,
          referredName: r.referred_parent_name,
          referredEmail: r.referred_parent_email,
          referrerName: r.referrer_parent_name,
          referrerEmail: r.referrer_parent_email,
          referrerCurrentCode: r.referrer_current_code,
        })),
        total: rows.length > 0 ? Number(rows[0].total_count) : 0,
        page,
        pageSize,
      }
    } catch (error) {
      return dbFailure(request, reply, "admin_referrals", error)
    }
  })

  app.patch("/v1/admin/referrals/settings", { bodyLimit: SMALL_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const b = request.body as Record<string, unknown> | null
    const KEYS = ["isEnabled", "rewardBasisPoints", "expectedUpdatedAt"]
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).length !== KEYS.length || KEYS.some((k) => !(k in b)) ||
        typeof b.isEnabled !== "boolean" || typeof b.rewardBasisPoints !== "number" || !Number.isInteger(b.rewardBasisPoints) ||
        typeof b.expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(b.expectedUpdatedAt))) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const row = await updateReferralProgramSettings(deps.db(), {
        adminUserId: request.authPrincipal!.userId,
        isEnabled: b.isEnabled,
        rewardBasisPoints: b.rewardBasisPoints,
        expectedUpdatedAt: b.expectedUpdatedAt,
      })
      return { status: row.status, isEnabled: row.is_enabled, rewardBasisPoints: row.reward_basis_points, updatedAt: row.updated_at }
    } catch (error) {
      return dbFailure(request, reply, "referral_settings", error)
    }
  })
}

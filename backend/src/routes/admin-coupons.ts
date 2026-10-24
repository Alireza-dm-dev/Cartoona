import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import {
  createAdminCoupon,
  getAdminCoupon,
  listAdminCouponPackages,
  listAdminCoupons,
  updateAdminCoupon,
  type AdminCouponRow,
} from "@/lib/repositories/admin-coupons"
import { deriveCouponStatus } from "@/lib/admin/coupons/status"
import type { AdminCouponDetail, AdminCouponListItem } from "@/lib/admin/coupons/types"
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  parseExpectedUpdatedAt,
  validateCouponInput,
} from "@/lib/admin/coupons/validation"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * ADMIN COUPONS (V0.1.51) - moved with purchase redemptions so that coupon
 * definitions, usage limits and redemptions live in ONE database.
 *
 *   GET   /v1/admin/coupons?search&status&discountType&page&pageSize   v2, admin
 *   GET   /v1/admin/coupons/packages                                   v2, admin
 *   GET   /v1/admin/coupons/:couponId                                  v2, admin
 *   POST  /v1/admin/coupons            coupon fields                   v3, admin
 *   PATCH /v1/admin/coupons/:couponId  coupon fields + expectedUpdatedAt  v3, admin
 *
 * The acting admin is ONLY `request.authPrincipal`; the trusted functions
 * re-check the admin role in PostgreSQL. Function refusals answer
 * `{ error: <token> }` (the Next route maps the Persian text; 422 field errors
 * come back as `{ error: "invalid_request", errors }`). No parent identity or
 * redemption id is ever returned.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES = new Set(["all", "active", "inactive", "scheduled", "expired"])
const TYPES = new Set(["all", "percentage", "fixed_amount"])
const LIST_KEYS = new Set(["search", "status", "discountType", "page", "pageSize"])
const COUPON_KEYS = [
  "code", "name", "description", "discountType", "discountValue", "isActive", "startsAt", "expiresAt",
  "globalUsageLimit", "perParentUsageLimit", "minimumPurchaseAmount", "maximumDiscountAmount", "packageIds",
]

export function toAdminCouponItem(row: AdminCouponRow): AdminCouponListItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    isActive: row.is_active,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    status: deriveCouponStatus(row.is_active, row.starts_at, row.expires_at),
    globalUsageLimit: row.global_usage_limit,
    perParentUsageLimit: row.per_parent_usage_limit,
    minimumPurchaseAmount: row.minimum_purchase_amount,
    maximumDiscountAmount: row.maximum_discount_amount,
    packageIds: row.package_ids,
    packageNames: row.package_names,
    reservedCount: row.reserved_count,
    redeemedCount: row.redeemed_count,
    cancelledCount: row.cancelled_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return fallback
  const n = Number(value)
  return n >= 1 ? n : fallback
}

function dbFailure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (error instanceof DbError && error.kind === "business" && error.businessCode?.startsWith("coupon_admin_")) {
    logEvent("info", "ADMIN_COUPON_REFUSED", { requestId: request.id, operation, reason: error.businessCode })
    const status = error.businessCode === "coupon_admin_forbidden" ? 403
      : error.businessCode === "coupon_admin_not_found" ? 404
      : error.businessCode === "coupon_admin_invalid" || error.businessCode === "coupon_admin_invalid_package" ? 422
      : 409
    return reply.code(status).send({ error: error.businessCode })
  }
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", "ADMIN_COUPON_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

async function detail(deps: BackendDeps, couponId: string): Promise<AdminCouponDetail | null> {
  const row = await getAdminCoupon(deps.db(), couponId)
  if (!row) return null
  return {
    ...toAdminCouponItem(row),
    createdBy: row.created_by_user_id ? { id: row.created_by_user_id, email: row.creator_email ?? "" } : null,
  }
}

export function registerAdminCouponRoutes(app: FastifyInstance, deps: BackendDeps): void {
  const read = { preHandler: [requireAuth(deps), requireRole("admin", "super_admin")] }

  app.get("/v1/admin/coupons", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const q = (request.query ?? {}) as Record<string, unknown>
    if (Object.keys(q).some((k) => !LIST_KEYS.has(k))) return reply.code(400).send({ error: "invalid_request" })
    const search = typeof q.search === "string" && q.search.trim() ? q.search.trim().slice(0, MAX_SEARCH_LENGTH) : null
    const status = typeof q.status === "string" && STATUSES.has(q.status) ? q.status : "all"
    const discountType = typeof q.discountType === "string" && TYPES.has(q.discountType) ? q.discountType : "all"
    const page = positiveInt(q.page, 1)
    const pageSize = Math.min(positiveInt(q.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
    try {
      const { rows, total } = await listAdminCoupons(deps.db(), {
        search,
        status: status as "all",
        discountType: discountType as "all",
        page,
        pageSize,
      })
      return {
        coupons: rows.map(toAdminCouponItem),
        pagination: { page, pageSize, total, totalPages: total > 0 ? Math.ceil(total / pageSize) : 0 },
      }
    } catch (error) {
      return dbFailure(request, reply, "admin_coupon_list", error)
    }
  })

  app.get("/v1/admin/coupons/packages", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    try {
      return { packages: await listAdminCouponPackages(deps.db()) }
    } catch (error) {
      return dbFailure(request, reply, "admin_coupon_packages", error)
    }
  })

  app.get("/v1/admin/coupons/:couponId", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const couponId = (request.params as { couponId?: string }).couponId
    if (typeof couponId !== "string" || !UUID.test(couponId)) return reply.code(404).send({ error: "coupon_admin_not_found" })
    try {
      const coupon = await detail(deps, couponId)
      if (!coupon) return reply.code(404).send({ error: "coupon_admin_not_found" })
      return { coupon }
    } catch (error) {
      return dbFailure(request, reply, "admin_coupon_detail", error)
    }
  })

  app.post("/v1/admin/coupons", { preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const body = request.body as Record<string, unknown> | null
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !COUPON_KEYS.includes(k))) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    const validated = validateCouponInput(body)
    if (!validated.ok) return reply.code(422).send({ error: "invalid_request", errors: validated.errors })
    try {
      const couponId = await createAdminCoupon(deps.db(), { adminUserId: request.authPrincipal!.userId, coupon: validated.input })
      logEvent("info", "ADMIN_COUPON_CREATED", { requestId: request.id, operation: "admin_coupon_create" })
      return reply.code(201).send({ coupon: await detail(deps, couponId) })
    } catch (error) {
      return dbFailure(request, reply, "admin_coupon_create", error)
    }
  })

  app.patch("/v1/admin/coupons/:couponId", { preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const couponId = (request.params as { couponId?: string }).couponId
    if (typeof couponId !== "string" || !UUID.test(couponId)) return reply.code(404).send({ error: "coupon_admin_not_found" })
    const body = request.body as Record<string, unknown> | null
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "expectedUpdatedAt" && !COUPON_KEYS.includes(k))) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    const expectedUpdatedAt = parseExpectedUpdatedAt(body.expectedUpdatedAt)
    if (expectedUpdatedAt === null) return reply.code(400).send({ error: "invalid_request" })
    const validated = validateCouponInput(body)
    if (!validated.ok) return reply.code(422).send({ error: "invalid_request", errors: validated.errors })
    try {
      await updateAdminCoupon(deps.db(), { adminUserId: request.authPrincipal!.userId, couponId, expectedUpdatedAt, coupon: validated.input })
      logEvent("info", "ADMIN_COUPON_UPDATED", { requestId: request.id, operation: "admin_coupon_update" })
      return { coupon: await detail(deps, couponId) }
    } catch (error) {
      return dbFailure(request, reply, "admin_coupon_update", error)
    }
  })
}

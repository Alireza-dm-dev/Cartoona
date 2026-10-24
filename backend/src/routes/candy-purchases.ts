import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import {
  applyCouponToPurchase,
  attemptBelongsTo,
  createCandyPurchase,
  createPaymentAttempt,
  listActiveCandyPackages,
  listParentPurchases,
  recordAttemptSession,
  validateCouponForPurchase,
} from "@/lib/repositories/candy-purchases"
import { mapCouponRpcError } from "@/lib/coupons/errors"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * CANDY PURCHASES (V0.1.51): catalog, history, purchase creation, coupons and
 * payment attempts, all on PostgreSQL. The wallet is credited ONLY by a
 * provider-verified event (routes/payment-events.ts); nothing here moves candy.
 *
 *   GET  /v1/candy-packages                                       public catalog
 *   GET  /v1/parent/candy-purchases                               v2, parent: history
 *   POST /v1/parent/candy-purchases            {packageId}        v3, parent: pending purchase
 *   GET  /v1/parent/candy-purchases/:id/coupon-validation?code=   v2, parent: read-only preview
 *   POST /v1/parent/candy-purchases/:id/coupon {code, idempotencyKey}            v3
 *   POST /v1/parent/candy-purchases/:id/payment-attempts {provider, idempotencyKey, checkoutExpiresAt}  v3
 *   POST /v1/parent/candy-purchases/:id/payment-attempts/:attemptId/session
 *        {providerSessionId, checkoutUrl, checkoutExpiresAt}                     v3
 *
 * The caller is ONLY `request.authPrincipal` -> the profile resolved here. No
 * body carries a user, profile, wallet, price, candy amount or status: price
 * and candy amount come from the ACTIVE catalog row inside
 * create_candy_purchase_trusted; the attempt amount is the purchase's payable
 * snapshot. Function refusals answer `{ error: <token> }` (the Next BFF maps
 * the Persian text); database failures `503 service_unavailable`. Every
 * response is no-store except the public catalog.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Za-z0-9_-]{3,32}$/
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,128}$/
const PROVIDER = /^[a-z][a-z0-9_-]{1,31}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

const PURCHASE_ERRORS: Record<string, number> = {
  purchase_parent_required: 403,
  purchase_package_unavailable: 404,
  attempt_purchase_not_found: 404,
  // Non-enumerating: another parent's purchase answers like a missing one.
  attempt_purchase_not_owner: 404,
  attempt_purchase_not_retryable: 409,
  attempt_nothing_to_charge: 409,
  attempt_not_created: 409,
  attempt_session_already_set: 409,
  attempt_not_found: 404,
}

function exactKeys(body: unknown, keys: string[]): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  const got = Object.keys(o)
  if (got.length !== keys.length || got.some((k) => !keys.includes(k))) return null
  return o
}

function hasQuery(request: FastifyRequest): boolean {
  return Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0
}

function failure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (error instanceof DbError && error.kind === "business" && error.businessCode) {
    const token = error.businessCode
    const status = PURCHASE_ERRORS[token] ?? (token.startsWith("coupon_") ? mapCouponRpcError(token).status : 422)
    const safe = PURCHASE_ERRORS[token] || token.startsWith("coupon_") ? token : "request_failed"
    logEvent("info", "PURCHASE_WRITE_REFUSED", { requestId: request.id, operation, reason: safe })
    return reply.code(status === 500 ? 422 : status).send({ error: safe })
  }
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", "PURCHASE_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

async function profileOf(request: FastifyRequest, deps: BackendDeps): Promise<string | null> {
  return findParentProfileIdByUserId(deps.db(), { userId: request.authPrincipal!.userId })
}

const noProfile = (reply: FastifyReply) => reply.code(404).send({ error: "parent_profile_not_found" })
const invalid = (request: FastifyRequest, reply: FastifyReply, operation: string, reason: string) => {
  logEvent("info", "PURCHASE_REQUEST_REJECTED", { requestId: request.id, operation, reason })
  return reply.code(400).send({ error: "invalid_request" })
}

function purchaseIdParam(request: FastifyRequest): string | null {
  const id = (request.params as { purchaseId?: unknown }).purchaseId
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null
}

export function registerCandyPurchaseRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get("/v1/candy-packages", async (request, reply) => {
    try {
      const packages = await listActiveCandyPackages(deps.db())
      reply.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600")
      return { packages }
    } catch (error) {
      reply.header("Cache-Control", "no-store")
      return failure(request, reply, "candy_packages", error)
    }
  })

  const read = { preHandler: [requireAuth(deps), requireRole("parent")] }

  app.get("/v1/parent/candy-purchases", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "candy_purchases_list"
    if (hasQuery(request)) return invalid(request, reply, operation, "query")
    try {
      const parentProfileId = await profileOf(request, deps)
      if (!parentProfileId) return noProfile(reply)
      return { purchases: await listParentPurchases(deps.db(), { parentProfileId }) }
    } catch (error) {
      return failure(request, reply, operation, error)
    }
  })

  app.post("/v1/parent/candy-purchases", { preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "candy_purchase_create"
    if (hasQuery(request)) return invalid(request, reply, operation, "query")
    const body = exactKeys(request.body, ["packageId"])
    if (!body || typeof body.packageId !== "string" || !UUID.test(body.packageId)) return invalid(request, reply, operation, "body")
    try {
      const parentProfileId = await profileOf(request, deps)
      if (!parentProfileId) return noProfile(reply)
      const purchase = await createCandyPurchase(deps.db(), { parentProfileId, packageId: body.packageId })
      logEvent("info", "PURCHASE_CREATED", { requestId: request.id, operation })
      return reply.code(201).send({ purchase })
    } catch (error) {
      return failure(request, reply, operation, error)
    }
  })

  app.get("/v1/parent/candy-purchases/:purchaseId/coupon-validation", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "coupon_validate"
    const purchaseId = purchaseIdParam(request)
    const query = (request.query ?? {}) as Record<string, unknown>
    const keys = Object.keys(query)
    if (!purchaseId || keys.length !== 1 || keys[0] !== "code" || typeof query.code !== "string" || !CODE.test(query.code)) {
      return invalid(request, reply, operation, "params")
    }
    try {
      const parentProfileId = await profileOf(request, deps)
      if (!parentProfileId) return noProfile(reply)
      return { coupon: await validateCouponForPurchase(deps.db(), { parentProfileId, purchaseId, code: query.code.toUpperCase() }) }
    } catch (error) {
      return failure(request, reply, operation, error)
    }
  })

  app.post("/v1/parent/candy-purchases/:purchaseId/coupon", { preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "coupon_apply"
    const purchaseId = purchaseIdParam(request)
    const body = exactKeys(request.body, ["code", "idempotencyKey"])
    if (
      !purchaseId || hasQuery(request) || !body ||
      typeof body.code !== "string" || !CODE.test(body.code) ||
      typeof body.idempotencyKey !== "string" || !IDEMPOTENCY.test(body.idempotencyKey)
    ) {
      return invalid(request, reply, operation, "body")
    }
    try {
      const parentProfileId = await profileOf(request, deps)
      if (!parentProfileId) return noProfile(reply)
      const coupon = await applyCouponToPurchase(deps.db(), { parentProfileId, purchaseId, code: body.code.toUpperCase(), idempotencyKey: body.idempotencyKey })
      return { coupon }
    } catch (error) {
      return failure(request, reply, operation, error)
    }
  })

  app.post("/v1/parent/candy-purchases/:purchaseId/payment-attempts", { preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "payment_attempt_create"
    const purchaseId = purchaseIdParam(request)
    const body = exactKeys(request.body, ["provider", "idempotencyKey", "checkoutExpiresAt"])
    if (
      !purchaseId || hasQuery(request) || !body ||
      typeof body.provider !== "string" || !PROVIDER.test(body.provider) ||
      typeof body.idempotencyKey !== "string" || !IDEMPOTENCY.test(body.idempotencyKey) ||
      (body.checkoutExpiresAt !== null && (typeof body.checkoutExpiresAt !== "string" || !ISO.test(body.checkoutExpiresAt)))
    ) {
      return invalid(request, reply, operation, "body")
    }
    try {
      const parentProfileId = await profileOf(request, deps)
      if (!parentProfileId) return noProfile(reply)
      const attempt = await createPaymentAttempt(deps.db(), {
        parentProfileId,
        purchaseId,
        provider: body.provider,
        idempotencyKey: body.idempotencyKey,
        checkoutExpiresAt: body.checkoutExpiresAt as string | null,
      })
      return {
        attempt: {
          id: attempt.id,
          status: attempt.status,
          amount: attempt.requested_amount,
          currency: attempt.requested_currency,
          providerSessionId: attempt.provider_session_id,
          checkoutUrl: attempt.checkout_url,
        },
      }
    } catch (error) {
      return failure(request, reply, operation, error)
    }
  })

  app.post("/v1/parent/candy-purchases/:purchaseId/payment-attempts/:attemptId/session", { preHandler: [requireWriteAuth(deps, "parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "payment_attempt_session"
    const purchaseId = purchaseIdParam(request)
    const attemptId = (request.params as { attemptId?: unknown }).attemptId
    const body = exactKeys(request.body, ["providerSessionId", "checkoutUrl", "checkoutExpiresAt"])
    if (
      !purchaseId || typeof attemptId !== "string" || !UUID.test(attemptId) || hasQuery(request) || !body ||
      typeof body.providerSessionId !== "string" || body.providerSessionId.length < 1 || body.providerSessionId.length > 200 ||
      typeof body.checkoutUrl !== "string" || !/^https?:\/\/[^\s]{1,1000}$/.test(body.checkoutUrl) ||
      (body.checkoutExpiresAt !== null && (typeof body.checkoutExpiresAt !== "string" || !ISO.test(body.checkoutExpiresAt)))
    ) {
      return invalid(request, reply, operation, "body")
    }
    try {
      const parentProfileId = await profileOf(request, deps)
      if (!parentProfileId) return noProfile(reply)
      // record_payment_attempt_session_trusted takes only the attempt id: ownership is checked here.
      if (!(await attemptBelongsTo(deps.db(), { parentProfileId, purchaseId, attemptId }))) {
        return reply.code(404).send({ error: "attempt_not_found" })
      }
      const attempt = await recordAttemptSession(deps.db(), {
        attemptId,
        providerSessionId: body.providerSessionId,
        checkoutUrl: body.checkoutUrl,
        checkoutExpiresAt: body.checkoutExpiresAt as string | null,
      })
      return { attempt: { id: attempt.id, status: attempt.status, checkoutUrl: attempt.checkout_url } }
    } catch (error) {
      return failure(request, reply, operation, error)
    }
  })
}

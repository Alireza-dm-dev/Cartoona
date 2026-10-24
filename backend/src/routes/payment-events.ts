import type { FastifyInstance } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { confirmPaymentEvent, failPaymentEvent } from "@/lib/repositories/candy-purchases"
import type { BackendDeps } from "../app"
import { requireServiceAuth } from "../plugins/auth"

/**
 * POST /v1/payments/events (V0.1.51) - the ONLY way candy is credited for a
 * purchase. Called by the Next server after it verified the PROVIDER (a
 * webhook signature, or a server-to-server verification call on the browser
 * return); authenticated with a SERVICE assertion (s1, svc "payments": body
 * digest + single-use nonce). No parent identity is accepted or needed, and a
 * parent's v2/v3 assertion is refused here, so a parent cannot mark their own
 * purchase paid through any internal route.
 *
 * Body, exact keys:
 *   { provider, eventId, type: "payment.succeeded", sessionId, transactionId, amount, currency, failureCode: null }
 *   { provider, eventId, type: "payment.failed",    sessionId, transactionId: null, amount: null, currency: null, failureCode }
 *
 * 200 { outcome, purchaseId }   every handled outcome, including duplicates and
 *     mismatches (the provider must not retry those); see migration 0017
 * 400 invalid_request
 * 401 / 409 / 503               requireServiceAuth
 * 503 service_unavailable       database failure: nothing was written (one
 *                               transaction); the provider retries, the event is
 *                               processed exactly once
 */

const PROVIDER = /^[a-z][a-z0-9_-]{1,31}$/
const REF = /^[A-Za-z0-9._:-]{1,200}$/
const CURRENCY = /^[A-Z]{3}$/
const KEYS = ["amount", "currency", "eventId", "failureCode", "provider", "sessionId", "transactionId", "type"]

export const PAYMENT_EVENTS_PATH = "/v1/payments/events"

export function registerPaymentEventRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.post(PAYMENT_EVENTS_PATH, { preHandler: [requireServiceAuth(deps, "payments")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "payment_event"
    const invalid = (reason: string) => {
      logEvent("warn", "PAYMENT_EVENT_REJECTED", { requestId: request.id, operation, reason })
      return reply.code(400).send({ error: "invalid_request" })
    }
    const b = request.body as Record<string, unknown> | null
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).sort().join(",") !== KEYS.join(",")) return invalid("keys")
    if (typeof b.provider !== "string" || !PROVIDER.test(b.provider)) return invalid("provider")
    if (typeof b.eventId !== "string" || !REF.test(b.eventId) || typeof b.sessionId !== "string" || !REF.test(b.sessionId)) return invalid("refs")

    try {
      let result
      if (b.type === "payment.succeeded") {
        if (typeof b.transactionId !== "string" || !REF.test(b.transactionId)) return invalid("transaction")
        if (typeof b.amount !== "number" || !Number.isSafeInteger(b.amount) || b.amount <= 0) return invalid("amount")
        if (typeof b.currency !== "string" || !CURRENCY.test(b.currency) || b.failureCode !== null) return invalid("currency")
        result = await confirmPaymentEvent(deps.db(), {
          provider: b.provider, eventId: b.eventId, sessionId: b.sessionId, transactionId: b.transactionId, amount: b.amount, currency: b.currency,
        })
      } else if (b.type === "payment.failed") {
        if (b.transactionId !== null || b.amount !== null || b.currency !== null) return invalid("failed_shape")
        if (b.failureCode !== null && (typeof b.failureCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(b.failureCode))) return invalid("failure_code")
        result = await failPaymentEvent(deps.db(), { provider: b.provider, eventId: b.eventId, sessionId: b.sessionId, failureCode: b.failureCode as string | null })
      } else {
        return invalid("type")
      }
      const level = result.outcome === "processed" || result.outcome === "duplicate_event" || result.outcome === "already_paid" ? "info" : "warn"
      logEvent(level, "PAYMENT_EVENT_HANDLED", { requestId: request.id, operation, reason: result.outcome })
      return { outcome: result.outcome, purchaseId: result.purchaseId }
    } catch (error) {
      if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
      logEvent("warn", "PAYMENT_EVENT_FAILED", {
        requestId: request.id,
        operation,
        subsystem: "database",
        errorCode: "DATABASE_UNAVAILABLE",
        reason: error instanceof DbError ? (error.businessCode ?? error.kind) : "config",
      })
      return reply.code(503).send({ error: "service_unavailable" })
    }
  })
}

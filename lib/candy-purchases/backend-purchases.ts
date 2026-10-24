import "server-only"

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { backendGetJson, backendServiceWriteJson, backendWriteJson } from "@/lib/backend/client"
import { isBackendClientError } from "@/lib/backend/errors"
import { currentRequestId, log } from "@/lib/observability/request-context"
import { mapBackendRejection, type BackendParentRejection, type ParentBackendFailure } from "@/lib/parent/backend-caller"
import { PaymentProviderError, type PaymentProviderAdapter, type ProviderEvent } from "@/lib/payments/providers/types"
import { toParentCandyPurchaseSummary, type CandyPackageSummary, type ParentCandyPurchaseSummary } from "./types"

/**
 * Candy purchases through the backend (V0.1.51). The ONLY purchase/payment
 * path from Next; no Supabase table or RPC is read or written here.
 *
 *   parent calls   verified Supabase context -> v2 (reads) / v3 (writes) -> Fastify -> PostgreSQL
 *   provider calls the adapter verified the PROVIDER -> s1 service assertion -> POST /v1/payments/events
 *
 * Each call is ONE attempt and never re-sent. Purchase creation, coupon apply
 * and attempt creation move no money (the wallet is credited only by a
 * provider-verified event), so a lost answer is reported as "try again": the
 * retry is safe (a new pending purchase has no financial effect; coupon apply
 * and attempt creation are idempotent per key).
 */

type Outcome = { status: number; body: Record<string, unknown> }
const relay = (json: unknown, status: number): Outcome => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body")
  return { status, body: json as Record<string, unknown> }
}
const ACCEPT = [400, 401, 403, 404, 409, 422, 503] as const
const AUTH_ERRORS = new Set(["unauthenticated", "session_expired", "session_invalidated", "identity_not_linked", "forbidden", "parent_profile_not_found"])

export type PurchaseCallFailure =
  | { ok: false; kind: "auth"; reason: ParentBackendFailure }
  | { ok: false; kind: "refused"; status: number; error: string }
  | { ok: false; kind: "unavailable"; outcomeUnknown: boolean }

function rejection(out: Outcome): PurchaseCallFailure {
  const error = typeof out.body.error === "string" ? out.body.error : "request_failed"
  if (out.status === 401 || AUTH_ERRORS.has(error)) {
    return { ok: false, kind: "auth", reason: mapBackendRejection((AUTH_ERRORS.has(error) ? error : "unauthenticated") as BackendParentRejection) }
  }
  if (out.status === 503) return { ok: false, kind: "unavailable", outcomeUnknown: false }
  return { ok: false, kind: "refused", status: out.status, error }
}

async function get(context: VerifiedAuthContext, operation: string, path: string, query?: Record<string, string>): Promise<Outcome | PurchaseCallFailure> {
  try {
    const { data } = await backendGetJson({ operation, path, query, requestId: currentRequestId(), auth: context, acceptStatuses: ACCEPT, parse: relay })
    return data.status >= 200 && data.status < 300 ? data : rejection(data)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: false }
    throw error
  }
}

async function write(context: VerifiedAuthContext, operation: string, path: string, body: unknown): Promise<Outcome | PurchaseCallFailure> {
  try {
    const { data } = await backendWriteJson({ operation, method: "POST", path, body, requestId: currentRequestId(), auth: context, acceptStatuses: ACCEPT, parse: relay })
    if (data.status >= 200 && data.status < 300) return data
    if (data.body.error === "replayed_request") return { ok: false, kind: "unavailable", outcomeUnknown: true }
    return rejection(data)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: error.outcomeUnknown }
    throw error
  }
}

const isFailure = (x: Outcome | PurchaseCallFailure): x is PurchaseCallFailure => "ok" in x

// ── catalog (public) ─────────────────────────────────────────────────────────

export async function loadCandyPackages(): Promise<CandyPackageSummary[] | null> {
  try {
    const { data } = await backendGetJson({ operation: "candy_packages", path: "/v1/candy-packages", requestId: currentRequestId(), parse: relay })
    const list = data.body.packages
    if (!Array.isArray(list)) return null
    return list.map((p: Record<string, unknown>) => ({
      id: String(p.id),
      name: String(p.name),
      description: typeof p.description === "string" ? p.description : null,
      candyAmount: Number(p.candyAmount),
      priceAmount: Number(p.priceAmount),
      currency: String(p.currency),
      displayOrder: Number(p.displayOrder),
    }))
  } catch (error) {
    if (isBackendClientError(error)) return null
    throw error
  }
}

// ── parent reads / writes ────────────────────────────────────────────────────

export async function loadPurchaseHistory(context: VerifiedAuthContext): Promise<{ ok: true; purchases: ParentCandyPurchaseSummary[] } | PurchaseCallFailure> {
  const out = await get(context, "candy_purchases", "/v1/parent/candy-purchases")
  if (isFailure(out)) return out
  const rows = out.body.purchases
  if (!Array.isArray(rows)) return { ok: false, kind: "unavailable", outcomeUnknown: false }
  return {
    ok: true,
    purchases: rows.map((r: Record<string, unknown>) =>
      toParentCandyPurchaseSummary(
        {
          id: String(r.id),
          candy_amount: Number(r.candy_amount),
          price_amount: Number(r.price_amount),
          original_price_amount: Number(r.original_price_amount),
          discount_amount: Number(r.discount_amount),
          final_price_amount: Number(r.final_price_amount),
          currency: String(r.currency),
          status: String(r.status),
          created_at: String(r.created_at),
          paid_at: typeof r.paid_at === "string" ? r.paid_at : null,
          coupon_code_snapshot: typeof r.coupon_code_snapshot === "string" ? r.coupon_code_snapshot : null,
          coupon_status: r.coupon_status === "reserved" || r.coupon_status === "redeemed" || r.coupon_status === "cancelled" ? r.coupon_status : null,
          coupon_name: typeof r.coupon_name === "string" ? r.coupon_name : null,
          payment_started: r.payment_started === true,
        },
        typeof r.package_name === "string" ? r.package_name : "",
      ),
    ),
  }
}

export async function createPurchase(context: VerifiedAuthContext, packageId: string): Promise<{ ok: true; purchase: Record<string, unknown> } | PurchaseCallFailure> {
  const out = await write(context, "candy_purchase_create", "/v1/parent/candy-purchases", { packageId })
  if (isFailure(out)) return out
  return { ok: true, purchase: out.body.purchase as Record<string, unknown> }
}

export async function validateCoupon(context: VerifiedAuthContext, purchaseId: string, code: string): Promise<{ ok: true; coupon: Record<string, unknown> } | PurchaseCallFailure> {
  const out = await get(context, "coupon_validate", `/v1/parent/candy-purchases/${purchaseId}/coupon-validation`, { code })
  if (isFailure(out)) return out
  return { ok: true, coupon: out.body.coupon as Record<string, unknown> }
}

export async function applyCoupon(
  context: VerifiedAuthContext,
  purchaseId: string,
  code: string,
  idempotencyKey: string,
): Promise<{ ok: true; coupon: Record<string, unknown> } | PurchaseCallFailure> {
  const out = await write(context, "coupon_apply", `/v1/parent/candy-purchases/${purchaseId}/coupon`, { code, idempotencyKey })
  if (isFailure(out)) return out
  return { ok: true, coupon: out.body.coupon as Record<string, unknown> }
}

export type StartPaymentResult =
  | { ok: true; checkoutUrl: string }
  | PurchaseCallFailure
  | { ok: false; kind: "provider_unavailable" }

/**
 * Start (or resume) paying a purchase:
 *   1. attempt (PostgreSQL, idempotent per key; amount = the payable snapshot)
 *   2. provider session for exactly that amount, referencing OUR attempt id
 *   3. session recorded on the attempt (PostgreSQL)
 * A retry with the SAME key returns the same attempt; if it already has a
 * session the stored checkout URL is returned and no second session is made.
 * Moves no money: only a provider-verified event credits the wallet.
 */
export async function startPayment(
  context: VerifiedAuthContext,
  provider: PaymentProviderAdapter,
  input: { purchaseId: string; idempotencyKey: string; returnUrl: string },
): Promise<StartPaymentResult> {
  const created = await write(context, "payment_attempt_create", `/v1/parent/candy-purchases/${input.purchaseId}/payment-attempts`, {
    provider: provider.id,
    idempotencyKey: input.idempotencyKey,
    checkoutExpiresAt: null,
  })
  if (isFailure(created)) return created
  const attempt = created.body.attempt as { id: string; amount: number; currency: string; checkoutUrl: string | null }
  if (attempt.checkoutUrl) return { ok: true, checkoutUrl: attempt.checkoutUrl }

  let session
  try {
    session = await provider.createSession({ attemptId: attempt.id, amount: attempt.amount, currency: attempt.currency, returnUrl: input.returnUrl })
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error
    log("warn", "PAYMENT_PROVIDER_FAILED", { subsystem: "payment", operation: "create_session", errorCode: error.kind })
    return { ok: false, kind: "provider_unavailable" }
  }

  const recorded = await write(context, "payment_attempt_session", `/v1/parent/candy-purchases/${input.purchaseId}/payment-attempts/${attempt.id}/session`, {
    providerSessionId: session.sessionId,
    checkoutUrl: session.checkoutUrl,
    checkoutExpiresAt: session.expiresAt,
  })
  if (isFailure(recorded)) {
    // An earlier try of this SAME key recorded its session: use that one.
    if (recorded.kind === "refused" && recorded.error === "attempt_session_already_set") {
      const again = await write(context, "payment_attempt_create", `/v1/parent/candy-purchases/${input.purchaseId}/payment-attempts`, {
        provider: provider.id,
        idempotencyKey: input.idempotencyKey,
        checkoutExpiresAt: null,
      })
      if (!isFailure(again)) {
        const url = (again.body.attempt as { checkoutUrl: string | null }).checkoutUrl
        if (url) return { ok: true, checkoutUrl: url }
      }
    }
    return recorded.kind === "unavailable" ? { ok: false, kind: "unavailable", outcomeUnknown: false } : recorded
  }
  return { ok: true, checkoutUrl: session.checkoutUrl }
}

// ── provider events (service-authenticated) ──────────────────────────────────

export type PaymentEventDelivery =
  | { ok: true; outcome: string; purchaseId: string | null }
  /** The backend did not confirm it handled the event: the provider must retry. */
  | { ok: false }

/** Hand a PROVIDER-VERIFIED event to the backend. One attempt; the provider's own retries cover failures. */
export async function deliverProviderEvent(provider: string, event: ProviderEvent): Promise<PaymentEventDelivery> {
  const body =
    event.type === "payment.succeeded"
      ? { provider, eventId: event.eventId, type: event.type, sessionId: event.sessionId, transactionId: event.transactionId, amount: event.amount, currency: event.currency, failureCode: null }
      : { provider, eventId: event.eventId, type: event.type, sessionId: event.sessionId, transactionId: null, amount: null, currency: null, failureCode: event.failureCode }
  try {
    const { data } = await backendServiceWriteJson({
      operation: "payment_event",
      path: "/v1/payments/events",
      body,
      requestId: currentRequestId(),
      service: "payments",
      acceptStatuses: [400, 409],
      parse: relay,
    })
    if (data.status !== 200 || typeof data.body.outcome !== "string") return { ok: false }
    return { ok: true, outcome: data.body.outcome, purchaseId: typeof data.body.purchaseId === "string" ? data.body.purchaseId : null }
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false }
    throw error
  }
}

/**
 * Welcome image credits - the business rule, kept apart from persistence.
 *
 * Product rule: every parent receives 3 one-time welcome IMAGE credits. They are
 * not candy, apply to image requests only, and are spent before candy. The
 * parent never chooses which balance pays.
 *
 * Where each piece lives:
 *  - THE RULE (this file, pure): which source pays for a request, and what the
 *    UI may claim. It has no database or Supabase knowledge.
 *  - ENFORCEMENT (database): supabase/migrations/20260926100000_welcome_image_credits.sql.
 *    The trusted request RPC applies the same rule atomically, under the wallet
 *    row lock, in the same transaction as the order insert. The RPC is the
 *    authority; this module mirrors it for display and is pinned to it by the
 *    real-SQL tests (tests/unit/welcome-image-credits-db.test.ts).
 *  - READ (V0.1.46): lib/repositories/welcome-credits.ts on PostgreSQL, served
 *    by the backend's GET /v1/parent/welcome-credits. The Supabase read
 *    (`readWelcomeImageCredits`) was removed with the cutover.
 *
 * Routes, UI and the rule here do not depend on where the counts live.
 */

export const WELCOME_IMAGE_CREDIT_GRANT = 3

export type PaymentSource = "candy" | "welcome_image_credit"

export type RequestKind = "image" | "video" | "drawing_animation"

export type ChargeDecision =
  | { ok: true; source: PaymentSource; candyCharged: number }
  | { ok: false; reason: "insufficient_candies" }

/**
 * Which source pays for one request.
 *
 *  - image + a credit remaining  -> the credit; no candy moves, balance irrelevant
 *  - image + no credit           -> candy at the catalog price (existing rule)
 *  - video / drawing animation   -> candy only; credits are never consulted
 */
export function decideCharge(input: {
  type: RequestKind
  welcomeCreditsRemaining: number
  candyBalance: number
  candyCost: number
}): ChargeDecision {
  if (input.type === "image" && input.welcomeCreditsRemaining > 0) {
    return { ok: true, source: "welcome_image_credit", candyCharged: 0 }
  }
  if (input.candyBalance < input.candyCost) {
    return { ok: false, reason: "insufficient_candies" }
  }
  return { ok: true, source: "candy", candyCharged: input.candyCost }
}

/** What the creation review may tell the parent. Display only; the server decides. */
export type CreditNotice =
  | { show: true; remaining: number }
  | { show: false }

/**
 * The free-credit notice appears for IMAGE requests with credits left and
 * nowhere else: video and drawing animation never claim eligibility, and an
 * unknown or zero count falls back to the ordinary candy display.
 */
export function creditNoticeFor(type: RequestKind, remaining: number | null): CreditNotice {
  if (type !== "image") return { show: false }
  if (remaining === null || !Number.isInteger(remaining) || remaining <= 0) return { show: false }
  return { show: true, remaining }
}

/** Normalise the payment source the RPC / API reports. Unknown or absent => candy. */
export function toPaymentSource(value: unknown): PaymentSource {
  return value === "welcome_image_credit" ? "welcome_image_credit" : "candy"
}

/** Clamp a stored count to a safe, displayable integer. */
export function normalizeRemaining(granted: unknown, used: unknown): number {
  if (typeof granted !== "number" || typeof used !== "number") return 0
  if (!Number.isFinite(granted) || !Number.isFinite(used)) return 0
  return Math.max(0, Math.trunc(granted) - Math.trunc(used))
}

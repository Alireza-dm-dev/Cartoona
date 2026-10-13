import type { RateLimitPolicy } from "./types"

/**
 * Named policies. Conservative MVP defaults, sized so normal UI behaviour -
 * double clicks, a retry after a network blip, load-more, a few coupon tries -
 * never trips them, while scripted abuse does.
 *
 * Limits are per authenticated parent (user id), never per IP, so households
 * and offices sharing a network do not share a bucket.
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const RATE_LIMIT_POLICIES = {
  /** POST /api/requests - burst. Each submission can upload 10 MiB and write 3+ rows. */
  requestSubmitBurst: { name: "request_submit_burst", limit: 5, windowMs: MINUTE },
  /** POST /api/requests - sustained. */
  requestSubmitHourly: { name: "request_submit_hourly", limit: 30, windowMs: HOUR },
  /** POST /api/parent/orders/[orderId]/final-media - signs a URL + writes an audit row. */
  finalMediaSign: { name: "final_media_sign", limit: 30, windowMs: MINUTE },
  /** POST /api/coupons/validate - read-only but hits a trusted RPC; also stops code guessing. */
  couponValidate: { name: "coupon_validate", limit: 20, windowMs: MINUTE },
  /** POST /api/candy-purchases/[id]/coupon - mutates the purchase. */
  couponApply: { name: "coupon_apply", limit: 10, windowMs: MINUTE },
  /** POST /api/candy-purchases and /[id]/complete. */
  candyPurchaseMutation: { name: "candy_purchase_mutation", limit: 10, windowMs: MINUTE },
  /** POST /api/parent/password - expensive hash + auth-admin write. */
  passwordChange: { name: "password_change", limit: 5, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitPolicy>

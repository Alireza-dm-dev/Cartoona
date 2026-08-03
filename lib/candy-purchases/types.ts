export type PurchaseStatusLabel = "pending" | "paid" | "failed" | "cancelled" | "expired"

export interface CandyPackageSummary {
  id: string
  name: string
  description: string | null
  candyAmount: number
  priceAmount: number
  currency: string
  displayOrder: number
}

export type CouponAppliedStatus = "reserved" | "redeemed" | "cancelled"

/**
 * Read-model summary of a candy purchase for the parent billing dashboard.
 * Pricing mirrors the persisted snapshot columns on candy_purchases
 * (original_price_amount / discount_amount / final_price_amount). Coupon
 * fields are safe, derived values only — internal IDs (coupon_id, redemption_id,
 * payment_attempt_id, provider state) are NEVER exposed to the browser.
 */
export interface ParentCandyPurchaseSummary {
  id: string
  packageName: string
  candyAmount: number
  priceAmount: number
  originalPriceAmount: number
  discountAmount: number
  finalPriceAmount: number
  currency: string
  status: PurchaseStatusLabel
  createdAt: string
  paidAt: string | null
  couponApplied: boolean
  couponCodeSnapshot: string | null
  couponName: string | null
  couponStatus: CouponAppliedStatus | null
  paymentStarted: boolean
}

/**
 * Raw rows + derived lookups assembled by the GET /api/candy-purchases route.
 * All names are snake_case DB columns except the derived lookups.
 */
export interface PurchaseReadModelRow {
  id: string
  candy_amount: number
  price_amount: number
  original_price_amount: number
  discount_amount: number
  final_price_amount: number
  currency: string
  status: string
  created_at: string
  paid_at: string | null
  coupon_code_snapshot: string | null
  coupon_status: CouponAppliedStatus | null
  coupon_name: string | null
  payment_started: boolean
}

/**
 * Serializes a candy_purchases row (joined with safe redemption/payment
 * lookups) into the parent-facing summary. Never emits internal IDs.
 */
export function toParentCandyPurchaseSummary(row: PurchaseReadModelRow, packageName: string): ParentCandyPurchaseSummary {
  return {
    id: row.id,
    packageName,
    candyAmount: row.candy_amount,
    priceAmount: row.price_amount,
    originalPriceAmount: row.original_price_amount,
    discountAmount: row.discount_amount,
    finalPriceAmount: row.final_price_amount,
    currency: row.currency,
    status: row.status as PurchaseStatusLabel,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    couponApplied: row.coupon_status === "reserved" || row.coupon_status === "redeemed",
    couponCodeSnapshot: row.coupon_code_snapshot,
    couponName: row.coupon_name,
    couponStatus: row.coupon_status,
    paymentStarted: row.payment_started,
  }
}

export interface ParentCandyBillingResponse {
  wallet: {
    balance: number
  }
  purchases: ParentCandyPurchaseSummary[]
}

export interface CandyPurchaseCreateRequest {
  package_id: string
}

export interface CandyPurchaseCreateResponse {
  purchase: {
    id: string
    candy_amount: number
    price_amount: number
    currency: string
    status: string
    created_at: string
  }
}

export interface CandyPurchaseCompleteResponse {
  purchase_id: string
  purchase_status: string
  wallet_id: string
  wallet_balance: number
  ledger_entry_id: string
}

export type CandyPurchaseApiErrorCode =
  | "purchase_unauthenticated"
  | "purchase_parent_required"
  | "purchase_parent_profile_missing"
  | "purchase_not_found"
  | "purchase_not_owner"
  | "purchase_not_pending"
  | "purchase_wallet_not_found"

export type CandyBillingDashboardPhase =
  | "loading"
  | "success"
  | "error"

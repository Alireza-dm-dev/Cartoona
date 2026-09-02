import type { ExampleKind, OrderStatus, OrderType, ModerationStatus, UserRole } from "./app";

export interface DbUser {
  id: string;
  email: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DbParentProfile {
  id: string;
  user_id: string;
  full_name: string;
  consent_granted: boolean;
  consent_granted_at: string | null;
  referral_code: string;
  created_at: string;
  updated_at: string;
}

export interface DbChildProfile {
  id: string;
  parent_id: string;
  name: string;
  birth_year: number | null;
  favorite_character_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbCharacter {
  id: string;
  name: string;
  description: string;
  category: string;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbOrder {
  id: string;
  parent_id: string;
  type: OrderType;
  status: OrderStatus;
  title: string;
  description: string | null;
  character_id: string | null;
  candy_cost: number;
  moderation_status: ModerationStatus;
  assigned_admin_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbExample {
  id: string;
  kind: ExampleKind;
  title: string;
  badge_label: string;
  description: string | null;
  character_id: string | null;
  media_url: string;
  thumbnail_url: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DbMediaAsset {
  id: string;
  order_id: string;
  type: "upload" | "generated";
  file_url: string;
  mime_type: string;
  moderation_status: ModerationStatus;
  created_at: string;
}

export interface DbCandyWallet {
  id: string;
  parent_id: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export type CandyTransactionType = "purchase" | "spend" | "refund" | "grant" | "order_debit";

export interface DbCandyTransaction {
  id: string;
  wallet_id: string;
  amount: number;
  type: CandyTransactionType;
  reference_type: string | null;
  reference_id: string | null;
  description: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface DbVideoRequest {
  id: string;
  order_id: string;
  script: string | null;
  duration_seconds: number | null;
  style: string | null;
  output_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbDrawingAnimationRequest {
  id: string;
  order_id: string;
  upload_url: string;
  animation_style: string | null;
  output_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbModerationLog {
  id: string;
  target_type: string;
  target_id: string;
  action: string;
  moderator_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface DbCreationPricing {
  id: string;
  pricing_key: string;
  candy_cost: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbAuditLog {
  id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ── Candy Purchase ──────────────────────────────────────────────────────────

export type PurchaseStatus = "pending" | "paid" | "failed" | "cancelled" | "expired";

export interface DbCandyPackage {
  id: string;
  name: string;
  description: string | null;
  candy_amount: number;
  price_amount: number;
  currency: string;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface DbCandyPurchase {
  id: string;
  parent_id: string;
  package_id: string;
  candy_amount: number;
  price_amount: number;
  original_price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
  status: PurchaseStatus;
  payment_reference: string | null;
  active_payment_attempt_id: string | null;
  payment_provider: string | null;
  provider_verified_at: string | null;
  expires_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}

// ── Coupon foundation ─────────────────────────────────────────────────────────

export type CouponDiscountType = "percentage" | "fixed_amount";

export type CouponRedemptionStatus = "reserved" | "redeemed" | "cancelled";

export interface DbCoupon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discount_type: CouponDiscountType;
  discount_value: number;
  is_active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  global_usage_limit: number | null;
  per_parent_usage_limit: number | null;
  minimum_purchase_amount: number | null;
  maximum_discount_amount: number | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbCouponPackageRule {
  coupon_id: string;
  package_id: string;
}

export interface DbCouponRedemption {
  id: string;
  coupon_id: string;
  purchase_id: string;
  parent_profile_id: string;
  normalized_code_snapshot: string;
  discount_type_snapshot: CouponDiscountType;
  discount_value_snapshot: number;
  original_price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
  status: CouponRedemptionStatus;
  idempotency_key: string;
  created_at: string;
  redeemed_at: string | null;
  cancelled_at: string | null;
}

// ── Coupon RPCs ──────────────────────────────────────────────────────────────

export interface ValidateCouponForPurchaseParams {
  p_parent_profile_id: string;
  p_purchase_id: string;
  p_coupon_code: string;
}

export interface ValidateCouponForPurchaseResult {
  coupon_id: string;
  normalized_code: string;
  discount_type: CouponDiscountType;
  original_price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
}

export interface ApplyCouponToPurchaseParams {
  p_parent_profile_id: string;
  p_purchase_id: string;
  p_coupon_code: string;
  p_idempotency_key: string;
}

export interface ApplyCouponToPurchaseResult {
  redemption_id: string;
  coupon_id: string;
  normalized_code: string;
  discount_type: CouponDiscountType;
  discount_value: number;
  original_price_amount: number;
  discount_amount: number;
  final_price_amount: number;
  currency: string;
  status: CouponRedemptionStatus;
}

export type CouponErrorCode =
  | "coupon_parent_required"
  | "coupon_purchase_required"
  | "coupon_code_invalid"
  | "coupon_purchase_not_found"
  | "coupon_purchase_not_owner"
  | "coupon_purchase_not_pending"
  | "coupon_purchase_has_payment_attempt"
  | "coupon_already_applied"
  | "coupon_not_found"
  | "coupon_inactive"
  | "coupon_not_started"
  | "coupon_expired"
  | "coupon_usage_limit_reached"
  | "coupon_parent_limit_reached"
  | "coupon_package_not_eligible"
  | "coupon_minimum_not_met"
  | "coupon_zero_discount"
  | "coupon_idempotency_required"
  | "coupon_idempotency_too_long";

// ── Payment (provider-neutral foundation) ────────────────────────────────────

export type PaymentAttemptStatus =
  | "created"
  | "awaiting_payment"
  | "processing"
  | "verified"
  | "failed"
  | "cancelled"
  | "expired";

export type PaymentWebhookProcessingStatus =
  | "received"
  | "processed"
  | "ignored"
  | "failed";

export interface DbPaymentAttempt {
  id: string;
  purchase_id: string;
  provider: string;
  status: PaymentAttemptStatus;
  provider_session_id: string | null;
  provider_transaction_id: string | null;
  provider_payment_reference: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  requested_amount: number;
  requested_currency: string;
  verified_amount: number | null;
  verified_currency: string | null;
  provider_verified_at: string | null;
  failure_code: string | null;
  failure_message_safe: string | null;
  attempt_number: number;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DbPaymentWebhookEvent {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  attempt_id: string | null;
  purchase_id: string | null;
  processing_status: PaymentWebhookProcessingStatus;
  received_at: string;
  processed_at: string | null;
  failure_code: string | null;
  created_at: string;
}

export interface CompleteCandyPurchaseResult {
  purchase_id: string;
  purchase_status: string;
  wallet_id: string;
  wallet_balance: number;
  ledger_entry_id: string;
}

export type PurchaseErrorCode =
  | "purchase_unauthenticated"
  | "purchase_parent_required"
  | "purchase_parent_profile_missing"
  | "purchase_not_found"
  | "purchase_not_owner"
  | "purchase_not_pending"
  | "purchase_wallet_not_found";

// ── Request Submission ───────────────────────────────────────────────────────

export type RequestSubmissionErrorCode =
  | "request_unauthenticated"
  | "request_parent_required"
  | "request_consent_required"
  | "request_parent_profile_missing"
  | "request_invalid_order_id"
  | "request_invalid_type"
  | "request_title_required"
  | "request_title_too_long"
  | "request_description_too_long"
  | "request_character_required"
  | "request_character_invalid"
  | "request_character_not_allowed"
  | "request_invalid_duration"
  | "request_duration_not_allowed"
  | "request_script_required"
  | "request_script_too_long"
  | "request_style_required"
  | "request_style_too_long"
  | "request_animation_style_required"
  | "request_animation_style_not_allowed"
  | "request_video_script_not_allowed"
  | "request_video_style_not_allowed"
  | "request_invalid_file_path"
  | "request_file_not_found"
  | "request_file_type_invalid"
  | "request_file_required"
  | "CREATION_PRICING_UNAVAILABLE"
  | "INSUFFICIENT_CANDIES"
  | "CANDY_WALLET_NOT_FOUND"
  | "unknown_error";

// ── RPCs ──────────────────────────────────────────────────────────────────

export interface CreateParentRequestParams {
  p_order_id: string
  p_type: string
  p_title: string
  p_description?: string | null
  p_character_id?: string | null
  p_duration_key?: string | null
  p_video_script?: string | null
  p_video_style?: string | null
  p_animation_style?: string | null
  p_file_path?: string | null
}

export interface CreateParentRequestResult {
  id: string
  type: string
  status: string
  candy_cost: number
}

export interface ParentSessionPolicyResult {
  session_started_at: string | null;
  expires_at: string | null;
  is_valid: boolean;
}

// ── Payment RPCs ──────────────────────────────────────────────────────────────

export type PaymentAttemptRowShape = DbPaymentAttempt;

export interface CreatePaymentAttemptParams {
  p_purchase_id: string;
  p_parent_profile_id: string;
  p_provider: string;
  p_checkout_expires_at: string | null;
  p_idempotency_key: string;
}

export interface CreatePaymentAttemptResult {
  attempt: PaymentAttemptRowShape;
}

export interface RecordPaymentAttemptSessionParams {
  p_attempt_id: string;
  p_provider_session_id: string;
  p_checkout_url: string | null;
  p_checkout_expires_at: string | null;
}

export interface RecordPaymentAttemptSessionResult {
  attempt: PaymentAttemptRowShape;
}

export type PaymentAttemptErrorCode =
  | "attempt_purchase_required"
  | "attempt_parent_required"
  | "attempt_provider_required"
  | "attempt_idempotency_required"
  | "attempt_idempotency_too_long"
  | "attempt_purchase_not_found"
  | "attempt_purchase_not_owner"
  | "attempt_purchase_not_retryable"
  | "attempt_id_required"
  | "attempt_session_id_required"
  | "attempt_not_found"
  | "attempt_not_created"
  | "attempt_session_already_set";

// ── Referral ─────────────────────────────────────────────────────────────────

export type BindingSource = "manual" | "signup_link";

export interface DbReferralProgramSettings {
  id: 1;
  is_enabled: boolean;
  reward_basis_points: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface DbReferralRelationship {
  id: string;
  referred_parent_id: string | null;
  referrer_parent_id: string | null;
  referral_code_snapshot: string;
  binding_source: BindingSource;
  bound_at: string;
}

// ── Referral RPCs ────────────────────────────────────────────────────────────

export interface ParentReferralSummaryResult {
  referral_code: string;
  is_enabled: boolean;
  reward_basis_points: number;
  is_bound: boolean;
  bound_at: string | null;
  referred_count: number;
}

export type ReferralBindStatus =
  | "bound"
  | "already_bound_same"
  | "already_bound_other"
  | "invalid_code"
  | "program_disabled"
  | "rate_limited"
  | "profile_not_found"
  | "session_expired";

export interface ReferralBindResult {
  status: ReferralBindStatus;
  bound_at: string | null;
}

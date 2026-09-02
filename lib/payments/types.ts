export type PaymentProviderId = "zarinpal" | "nextpay" | "unknown";

export type PaymentAttemptStatusLabel =
  | "created"
  | "awaiting_payment"
  | "processing"
  | "verified"
  | "failed"
  | "cancelled"
  | "expired";

export const PAYMENT_ATTEMPT_STATUS_LABELS: readonly PaymentAttemptStatusLabel[] = [
  "created",
  "awaiting_payment",
  "processing",
  "verified",
  "failed",
  "cancelled",
  "expired",
];

export type PaymentAttemptTerminalStatus = "verified" | "failed" | "cancelled" | "expired";

export interface PaymentAttemptSummary {
  id: string
  purchaseId: string
  provider: PaymentProviderId
  status: PaymentAttemptStatusLabel
  attemptNumber: number
  requestedAmount: number
  requestedCurrency: string
  verifiedAmount: number | null
  verifiedCurrency: string | null
  createdAt: string
  completedAt: string | null
}

export interface CreatePaymentAttemptInput {
  purchase_id: string
  provider: PaymentProviderId
  checkout_expires_at?: string | null
}

export interface CreatePaymentAttemptResult {
  attempt: PaymentAttemptSummary
}

export interface ProviderSessionData {
  provider_session_id: string
  checkout_url: string | null
  checkout_expires_at: string | null
}

export interface RecordPaymentAttemptSessionInput {
  attempt_id: string
  provider_session_id: string
  checkout_url?: string | null
  checkout_expires_at?: string | null
}

export interface RecordPaymentAttemptSessionResult {
  attempt: PaymentAttemptSummary
}

export type PaymentProviderErrorCode =
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

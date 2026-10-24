/**
 * Provider-neutral payment adapter (V0.1.51), the boundary docs/PAYMENT_PROVIDER_ARCHITECTURE.md
 * §4 describes. Server-only modules implement it; nothing here touches the
 * database: an adapter talks to the PROVIDER and turns what the provider
 * proves into a `ProviderEvent`, which the Next server hands to the backend
 * (POST /v1/payments/events, service assertion). Provider secrets stay in the
 * Next server; the backend never sees them.
 */

export type ProviderEvent =
  | {
      type: "payment.succeeded"
      /** The provider's event id (webhook), or a deterministic id for a server-side verification. */
      eventId: string
      sessionId: string
      transactionId: string
      /** Integer minor units as the provider charged them. */
      amount: number
      currency: string
    }
  | { type: "payment.failed"; eventId: string; sessionId: string; failureCode: string | null }

export interface CreateSessionInput {
  /** Our attempt id: the provider-side reference for reconciliation. */
  attemptId: string
  amount: number
  currency: string
  /** Where the provider sends the browser back. */
  returnUrl: string
}

export interface CreatedSession {
  sessionId: string
  checkoutUrl: string
  expiresAt: string | null
}

export type WebhookVerification = { ok: true; event: ProviderEvent | null } | { ok: false; reason: "invalid_signature" | "stale" | "malformed" }

export interface PaymentProviderAdapter {
  /** Stable lowercase id stored on payment_attempts.provider. */
  readonly id: string
  createSession(input: CreateSessionInput): Promise<CreatedSession>
  /**
   * Verify an incoming webhook over the RAW body. `event: null` = a verified
   * event type we do not act on (acknowledged, ignored).
   */
  verifyWebhook(rawBody: string, headers: Headers, now?: number): WebhookVerification
  /** Server-to-server status check (the browser return is never trusted by itself). */
  verifySession(sessionId: string): Promise<ProviderEvent | { type: "payment.pending" }>
}

export class PaymentProviderError extends Error {
  constructor(readonly kind: "not_configured" | "unavailable" | "rejected") {
    super(`payment provider: ${kind}`)
    this.name = "PaymentProviderError"
  }
}

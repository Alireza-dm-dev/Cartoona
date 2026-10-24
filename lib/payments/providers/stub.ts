import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"
import { PaymentProviderError, type PaymentProviderAdapter, type ProviderEvent } from "./types"

/**
 * The DETERMINISTIC STUB provider (V0.1.51): local development and tests only.
 * It speaks a tiny provider-shaped HTTP API (tests/helpers/stub-payment-provider.ts):
 *
 *   POST {base}/v1/sessions        Bearer API key -> { id, checkout_url, expires_at }
 *   GET  {base}/v1/sessions/:id    Bearer API key -> { id, status, transaction_id, amount, currency }
 *   webhooks to our /api/payments/webhooks/stub, signed:
 *     X-Stub-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * It is a real adapter in every respect that matters for security (signature
 * over the raw body, timestamp tolerance, constant-time compare, server-side
 * verification) so the same code paths are proven that a real provider will
 * use. It is NOT a payment method: anyone who can reach its checkout page can
 * "pay". Refused when NODE_ENV=production unless
 * CARTOONA_PAYMENT_STUB_UNSAFE_ALLOW_IN_PRODUCTION=1 (local container proofs
 * run the production build; never set it anywhere else).
 */

const TOLERANCE_SECONDS = 300
const TIMEOUT_MS = 5_000

type Env = Record<string, string | undefined>

export interface StubConfig {
  baseUrl: string
  apiKey: string
  webhookSecret: string
}

export function readStubConfig(env: Env = process.env): StubConfig | null {
  if (env.NODE_ENV === "production" && env.CARTOONA_PAYMENT_STUB_UNSAFE_ALLOW_IN_PRODUCTION !== "1") return null
  const baseUrl = env.CARTOONA_PAYMENT_STUB_URL?.trim().replace(/\/+$/, "")
  const apiKey = env.CARTOONA_PAYMENT_STUB_API_KEY?.trim()
  const webhookSecret = env.CARTOONA_PAYMENT_STUB_WEBHOOK_SECRET?.trim()
  if (!baseUrl || !/^https?:\/\/[^/?#@\s]+$/.test(baseUrl) || !apiKey || !webhookSecret || webhookSecret.length < 32) return null
  return { baseUrl, apiKey, webhookSecret }
}

export function stubSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
}

const REF = /^[A-Za-z0-9._:-]{1,200}$/

function toEvent(raw: Record<string, unknown>): ProviderEvent | null {
  const { id, type, session_id, transaction_id, amount, currency, failure_code } = raw
  if (typeof id !== "string" || !REF.test(id) || typeof session_id !== "string" || !REF.test(session_id)) return null
  if (type === "payment.succeeded") {
    if (typeof transaction_id !== "string" || !REF.test(transaction_id)) return null
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || typeof currency !== "string") return null
    return { type, eventId: id, sessionId: session_id, transactionId: transaction_id, amount, currency }
  }
  if (type === "payment.failed") {
    return { type, eventId: id, sessionId: session_id, failureCode: typeof failure_code === "string" ? failure_code : null }
  }
  return null
}

export function createStubAdapter(config: StubConfig, fetchImpl: typeof fetch = fetch): PaymentProviderAdapter {
  const call = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let res: Response
    try {
      res = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new PaymentProviderError("unavailable")
    }
    if (!res.ok) throw new PaymentProviderError(res.status >= 500 ? "unavailable" : "rejected")
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== "object") throw new PaymentProviderError("unavailable")
    return body
  }

  return {
    id: "stub",
    async createSession(input) {
      const body = await call("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ reference: input.attemptId, amount: input.amount, currency: input.currency, return_url: input.returnUrl }),
      })
      const { id, checkout_url, expires_at } = body
      if (typeof id !== "string" || !REF.test(id) || typeof checkout_url !== "string" || !/^https?:\/\//.test(checkout_url)) {
        throw new PaymentProviderError("unavailable")
      }
      return { sessionId: id, checkoutUrl: checkout_url, expiresAt: typeof expires_at === "string" ? expires_at : null }
    },
    verifyWebhook(rawBody, headers, now = Date.now()) {
      const header = headers.get("x-stub-signature") ?? ""
      const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header)
      if (!m) return { ok: false, reason: "invalid_signature" }
      const t = Number(m[1])
      const expected = Buffer.from(stubSignature(config.webhookSecret, t, rawBody), "hex")
      const got = Buffer.from(m[2], "hex")
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: "invalid_signature" }
      // Only after the MAC: the timestamp it covers bounds replays of a captured delivery.
      if (Math.abs(Math.floor(now / 1000) - t) > TOLERANCE_SECONDS) return { ok: false, reason: "stale" }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        return { ok: false, reason: "malformed" }
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "malformed" }
      return { ok: true, event: toEvent(parsed as Record<string, unknown>) }
    },
    async verifySession(sessionId) {
      if (!REF.test(sessionId)) throw new PaymentProviderError("rejected")
      const body = await call(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" })
      if (body.status === "paid") {
        const event = toEvent({ ...body, id: `verify:${sessionId}:${String(body.transaction_id)}`, type: "payment.succeeded", session_id: sessionId })
        if (!event) throw new PaymentProviderError("unavailable")
        return event
      }
      if (body.status === "failed") {
        return { type: "payment.failed", eventId: `verify:${sessionId}:failed`, sessionId, failureCode: typeof body.failure_code === "string" ? body.failure_code : null }
      }
      return { type: "payment.pending" }
    },
  }
}

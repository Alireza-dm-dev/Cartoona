import { describe, it, expect } from "vitest"
import { createStubAdapter, readStubConfig, stubSignature } from "@/lib/payments/providers/stub"
import { configuredPaymentProvider, paymentProviderFor } from "@/lib/payments/providers/registry"
import { PaymentProviderError } from "@/lib/payments/providers/types"

/**
 * V0.1.51 provider adapter boundary (replaces the old dev "payment simulation"
 * policy test: the simulated completion route is gone). The stub adapter is a
 * real verifier: signature over the raw body, constant-time compare, timestamp
 * tolerance - and it refuses to exist in production unless explicitly forced.
 */

const SECRET = "s".repeat(40)
const full = { CARTOONA_PAYMENT_STUB_URL: "http://127.0.0.1:4300", CARTOONA_PAYMENT_STUB_API_KEY: "key", CARTOONA_PAYMENT_STUB_WEBHOOK_SECRET: SECRET }
const adapter = createStubAdapter({ baseUrl: "http://stub", apiKey: "key", webhookSecret: SECRET })
const now = Date.UTC(2026, 9, 24, 12, 0, 0)
const t = Math.floor(now / 1000)
const headers = (sig: string) => new Headers({ "x-stub-signature": sig })
const event = JSON.stringify({ id: "evt_1", type: "payment.succeeded", session_id: "sess_1", transaction_id: "tx_1", amount: 45000, currency: "IRR" })

describe("which provider is configured", () => {
  it("none by default (production today): nothing can be paid", () => {
    expect(configuredPaymentProvider({})).toBeNull()
    expect(configuredPaymentProvider({ CARTOONA_PAYMENT_PROVIDER: "zarinpal", ...full })).toBeNull()
  })

  it("the stub needs complete config and a >= 32-char secret", () => {
    expect(readStubConfig({ NODE_ENV: "development", ...full })).not.toBeNull()
    expect(readStubConfig({ NODE_ENV: "development", ...full, CARTOONA_PAYMENT_STUB_WEBHOOK_SECRET: "short" })).toBeNull()
    expect(readStubConfig({ NODE_ENV: "development", ...full, CARTOONA_PAYMENT_STUB_API_KEY: "" })).toBeNull()
    expect(readStubConfig({ NODE_ENV: "development", ...full, CARTOONA_PAYMENT_STUB_URL: "http://user@host" })).toBeNull()
  })

  it.each([
    [{ NODE_ENV: "production", ...full }, false],
    [{ NODE_ENV: "production", ...full, CARTOONA_PAYMENT_STUB_UNSAFE_ALLOW_IN_PRODUCTION: "true" }, false],
    [{ NODE_ENV: "production", ...full, CARTOONA_PAYMENT_STUB_UNSAFE_ALLOW_IN_PRODUCTION: "1" }, true],
    [{ NODE_ENV: "test", ...full }, true],
  ])("NODE_ENV/override %j -> stub allowed: %s", (env, allowed) => {
    expect(readStubConfig(env) !== null).toBe(allowed)
  })

  it("webhook/return paths resolve only the configured provider, by exact id", () => {
    const env = { NODE_ENV: "test", CARTOONA_PAYMENT_PROVIDER: "stub", ...full }
    expect(paymentProviderFor("stub", env)?.id).toBe("stub")
    expect(paymentProviderFor("STUB", env)).toBeNull()
    expect(paymentProviderFor("other", env)).toBeNull()
  })
})

describe("webhook verification", () => {
  it("accepts the exact signed body and returns the normalized event", () => {
    const v = adapter.verifyWebhook(event, headers(`t=${t},v1=${stubSignature(SECRET, t, event)}`), now)
    expect(v).toEqual({ ok: true, event: { type: "payment.succeeded", eventId: "evt_1", sessionId: "sess_1", transactionId: "tx_1", amount: 45000, currency: "IRR" } })
  })

  it.each([
    ["no header", ""],
    ["wrong secret", `t=${t},v1=${stubSignature(SECRET + "x", t, event)}`],
    ["signature over another body", `t=${t},v1=${stubSignature(SECRET, t, event.replace("45000", "1"))}`],
    ["truncated hex", `t=${t},v1=${stubSignature(SECRET, t, event).slice(0, 63)}`],
    ["extra fields", `t=${t},v1=${stubSignature(SECRET, t, event)},v0=x`],
  ])("refuses %s as invalid_signature", (_l, sig) => {
    expect(adapter.verifyWebhook(event, headers(sig), now)).toEqual({ ok: false, reason: "invalid_signature" })
  })

  it("a correctly signed but old (or future) delivery is stale: replays of captured webhooks are bounded", () => {
    for (const ts of [t - 301, t + 301]) {
      expect(adapter.verifyWebhook(event, headers(`t=${ts},v1=${stubSignature(SECRET, ts, event)}`), now)).toEqual({ ok: false, reason: "stale" })
    }
  })

  it("a verified but unknown event type is acknowledged and ignored (event: null); malformed JSON is refused", () => {
    const other = JSON.stringify({ id: "evt_2", type: "refund.created", session_id: "s" })
    expect(adapter.verifyWebhook(other, headers(`t=${t},v1=${stubSignature(SECRET, t, other)}`), now)).toEqual({ ok: true, event: null })
    const bad = "{not json"
    expect(adapter.verifyWebhook(bad, headers(`t=${t},v1=${stubSignature(SECRET, t, bad)}`), now)).toEqual({ ok: false, reason: "malformed" })
  })
})

describe("provider calls", () => {
  it("createSession sends OUR attempt id and the amount; a provider error is a PaymentProviderError, never a crash", async () => {
    const calls: Array<[string, RequestInit]> = []
    const ok = createStubAdapter({ baseUrl: "http://stub", apiKey: "key", webhookSecret: SECRET }, (async (url: string, init: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ id: "sess_9", checkout_url: "http://stub/checkout/sess_9", expires_at: null }), { status: 200 })
    }) as unknown as typeof fetch)
    expect(await ok.createSession({ attemptId: "att-1", amount: 45000, currency: "IRR", returnUrl: "http://app/r" })).toEqual({ sessionId: "sess_9", checkoutUrl: "http://stub/checkout/sess_9", expiresAt: null })
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ reference: "att-1", amount: 45000, currency: "IRR", return_url: "http://app/r" })
    expect((calls[0][1].headers as Record<string, string>).authorization).toBe("Bearer key")

    const down = createStubAdapter({ baseUrl: "http://stub", apiKey: "key", webhookSecret: SECRET }, (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch)
    await expect(down.createSession({ attemptId: "a", amount: 1, currency: "IRR", returnUrl: "r" })).rejects.toBeInstanceOf(PaymentProviderError)
  })

  it("verifySession maps paid/failed/open, with a deterministic event id per verification", async () => {
    const fake = (body: unknown) => createStubAdapter({ baseUrl: "http://stub", apiKey: "key", webhookSecret: SECRET }, (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch)
    expect(await fake({ status: "paid", transaction_id: "tx_5", amount: 10, currency: "IRR" }).verifySession("sess_5")).toEqual({ type: "payment.succeeded", eventId: "verify:sess_5:tx_5", sessionId: "sess_5", transactionId: "tx_5", amount: 10, currency: "IRR" })
    expect(await fake({ status: "failed", failure_code: "declined" }).verifySession("sess_5")).toEqual({ type: "payment.failed", eventId: "verify:sess_5:failed", sessionId: "sess_5", failureCode: "declined" })
    expect(await fake({ status: "open" }).verifySession("sess_5")).toEqual({ type: "payment.pending" })
    await expect(fake({}).verifySession("bad id/../x")).rejects.toBeInstanceOf(PaymentProviderError)
  })
})

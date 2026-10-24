import http from "node:http"
import { createHmac } from "node:crypto"
import type { AddressInfo } from "node:net"

/**
 * A deterministic, in-process stand-in for a payment provider (V0.1.51). TESTS
 * AND LOCAL PROOFS ONLY. It speaks the API lib/payments/providers/stub.ts
 * expects:
 *
 *   POST /v1/sessions        Bearer <apiKey>  {reference, amount, currency, return_url}
 *                            -> {id, checkout_url, expires_at}
 *   GET  /v1/sessions/:id    Bearer <apiKey>  -> {id, status, transaction_id, amount, currency, failure_code}
 *   GET  /checkout/:id       HTML with "Pay" / "Decline" buttons (a browser can use it)
 *   POST /checkout/:id/pay | /decline   -> webhook(s), then 303 to return_url?session=<id>
 *
 * Webhooks are signed exactly like the adapter verifies them:
 *   X-Stub-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * `mode` makes it misbehave on purpose: drop the webhook, repeat it, sign it
 * wrongly, or report a charged amount different from the requested one.
 */

export interface StubSession {
  id: string
  reference: string
  amount: number
  currency: string
  returnUrl: string
  status: "open" | "paid" | "failed"
  transactionId: string | null
  failureCode: string | null
}

export interface WebhookDelivery {
  status: number
  body: string
  eventId: string
}

export type WebhookTarget = (rawBody: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>

export interface StubPaymentMode {
  /** "send" (default): one delivery; "drop": none; number N: the SAME event N times. */
  webhook: "send" | "drop" | number
  /** Deliver repeats concurrently instead of one after another. */
  concurrent: boolean
  badSignature: boolean
  /** The amount the provider reports as charged (default: the requested amount). */
  chargedAmount: number | null
  /** Signature timestamp offset in seconds (negative = in the past). */
  timestampOffset: number
}

export interface StubPaymentProvider {
  url: string
  apiKey: string
  webhookSecret: string
  sessions: Map<string, StubSession>
  deliveries: WebhookDelivery[]
  mode: StubPaymentMode
  requests: Array<{ method: string; path: string }>
  setWebhookTarget(target: WebhookTarget | string): void
  /** Mark paid and deliver per `mode` (what the "Pay" button does). */
  pay(sessionId: string): Promise<WebhookDelivery[]>
  decline(sessionId: string, failureCode?: string): Promise<WebhookDelivery[]>
  /** Sign arbitrary body bytes the way the provider would. */
  sign(rawBody: string, timestamp?: number): string
  close(): Promise<void>
}

export async function startStubPaymentProvider(opts: {
  apiKey: string
  webhookSecret: string
  port?: number
  host?: string
  /** Base URL the BROWSER uses for checkout pages (defaults to the server URL). */
  publicUrl?: string
}): Promise<StubPaymentProvider> {
  const sessions = new Map<string, StubSession>()
  const deliveries: WebhookDelivery[] = []
  const requests: Array<{ method: string; path: string }> = []
  const mode: StubPaymentMode = { webhook: "send", concurrent: false, badSignature: false, chargedAmount: null, timestampOffset: 0 }
  let target: WebhookTarget | null = null
  let counter = 0
  let eventCounter = 0

  const sign = (raw: string, t = Math.floor(Date.now() / 1000) + mode.timestampOffset) =>
    `t=${t},v1=${createHmac("sha256", mode.badSignature ? `${opts.webhookSecret}x` : opts.webhookSecret).update(`${t}.${raw}`).digest("hex")}`

  const deliver = async (event: Record<string, unknown>): Promise<WebhookDelivery[]> => {
    if (!target || mode.webhook === "drop") return []
    const raw = JSON.stringify(event)
    const times = typeof mode.webhook === "number" ? mode.webhook : 1
    const once = async () => {
      const res = await target!(raw, { "content-type": "application/json", "x-stub-signature": sign(raw) })
      const d = { status: res.status, body: res.body, eventId: String(event.id) }
      deliveries.push(d)
      return d
    }
    if (mode.concurrent) return Promise.all(Array.from({ length: times }, once))
    const out: WebhookDelivery[] = []
    for (let i = 0; i < times; i++) out.push(await once())
    return out
  }

  const pay = async (id: string) => {
    const s = sessions.get(id)
    if (!s) throw new Error("no such session")
    s.status = "paid"
    s.transactionId = s.transactionId ?? `tx_${id}`
    return deliver({
      id: `evt_${++eventCounter}`,
      type: "payment.succeeded",
      session_id: id,
      transaction_id: s.transactionId,
      amount: mode.chargedAmount ?? s.amount,
      currency: s.currency,
    })
  }
  const decline = async (id: string, failureCode = "declined") => {
    const s = sessions.get(id)
    if (!s) throw new Error("no such session")
    s.status = "failed"
    s.failureCode = failureCode
    return deliver({ id: `evt_${++eventCounter}`, type: "payment.failed", session_id: id, failure_code: failureCode })
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  let publicUrl = opts.publicUrl ?? ""
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub")
    requests.push({ method: req.method ?? "", path: url.pathname })
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", async () => {
      const authed = req.headers.authorization === `Bearer ${opts.apiKey}`
      if (url.pathname === "/v1/sessions" && req.method === "POST") {
        if (!authed) return json(res, 401, { error: "unauthorized" })
        let b: Record<string, unknown> = {}
        try { b = JSON.parse(raw) } catch { /* empty */ }
        if (typeof b.amount !== "number" || b.amount <= 0 || typeof b.currency !== "string" || typeof b.return_url !== "string") {
          return json(res, 400, { error: "invalid" })
        }
        const id = `sess_${++counter}_${Date.now().toString(36)}`
        sessions.set(id, {
          id, reference: String(b.reference), amount: b.amount, currency: b.currency, returnUrl: b.return_url,
          status: "open", transactionId: null, failureCode: null,
        })
        return json(res, 200, { id, checkout_url: `${publicUrl}/checkout/${id}`, expires_at: null })
      }
      const sessionMatch = /^\/v1\/sessions\/([A-Za-z0-9_]+)$/.exec(url.pathname)
      if (sessionMatch && req.method === "GET") {
        if (!authed) return json(res, 401, { error: "unauthorized" })
        const s = sessions.get(sessionMatch[1])
        if (!s) return json(res, 404, { error: "not_found" })
        return json(res, 200, { id: s.id, status: s.status, transaction_id: s.transactionId, amount: mode.chargedAmount ?? s.amount, currency: s.currency, failure_code: s.failureCode })
      }
      const checkout = /^\/checkout\/([A-Za-z0-9_]+)(\/pay|\/decline)?$/.exec(url.pathname)
      if (checkout) {
        const s = sessions.get(checkout[1])
        if (!s) return json(res, 404, { error: "not_found" })
        if (!checkout[2] && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          return res.end(`<!doctype html><html><body><h1>Stub checkout</h1><p id="amount">${s.amount} ${s.currency}</p>
            <form method="post" action="/checkout/${s.id}/pay"><button id="pay" type="submit">Pay</button></form>
            <form method="post" action="/checkout/${s.id}/decline"><button id="decline" type="submit">Decline</button></form></body></html>`)
        }
        if (req.method === "POST") {
          if (checkout[2] === "/pay") await pay(s.id)
          else await decline(s.id)
          res.writeHead(303, { location: `${s.returnUrl}?session=${encodeURIComponent(s.id)}` })
          return res.end()
        }
      }
      json(res, 404, { error: "not_found" })
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  if (!publicUrl) publicUrl = url

  return {
    url,
    apiKey: opts.apiKey,
    webhookSecret: opts.webhookSecret,
    sessions,
    deliveries,
    mode,
    requests,
    setWebhookTarget(t) {
      target = typeof t === "string"
        ? async (rawBody, headers) => {
            const r = await fetch(t, { method: "POST", body: rawBody, headers })
            return { status: r.status, body: await r.text() }
          }
        : t
    },
    pay,
    decline,
    sign,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

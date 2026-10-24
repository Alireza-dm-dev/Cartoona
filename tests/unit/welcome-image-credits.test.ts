import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import {
  decideCharge,
  creditNoticeFor,
  toPaymentSource,
  normalizeRemaining,
  WELCOME_IMAGE_CREDIT_GRANT,
  type RequestKind,
} from "@/lib/credits/welcome-image-credits"
import { toSubmissionSuccess } from "@/lib/requests/submission-response"
import { setLogSink, sanitizeFields, type LogRecord } from "@/lib/observability/logger"
import { setRateLimitStore, InMemoryRateLimitStore } from "@/lib/rate-limit"

const root = process.cwd()
const OID = "123e4567-e89b-42d3-a456-426614174000"
const KEY = "11111111-1111-4111-8111-111111111111"

// ── Domain rule ──────────────────────────────────────────────────────────────

describe("decideCharge (the payment-source rule)", () => {
  const image = (remaining: number, balance: number, cost = 12) =>
    decideCharge({ type: "image", welcomeCreditsRemaining: remaining, candyBalance: balance, candyCost: cost })

  it("the grant is exactly 3", () => expect(WELCOME_IMAGE_CREDIT_GRANT).toBe(3))

  it("images 1-3 use a welcome credit and charge no candy; the 4th uses candy", () => {
    let remaining = WELCOME_IMAGE_CREDIT_GRANT
    let balance = 12
    const sources: string[] = []
    for (let i = 0; i < 4; i++) {
      const d = image(remaining, balance)
      if (!d.ok) throw new Error("unexpected rejection")
      sources.push(d.source)
      if (d.source === "welcome_image_credit") remaining -= 1
      balance -= d.candyCharged
    }
    expect(sources).toEqual(["welcome_image_credit", "welcome_image_credit", "welcome_image_credit", "candy"])
    expect(remaining).toBe(0)
    expect(balance).toBe(0)
  })

  it("an image with 0 candy succeeds while a credit exists", () => {
    expect(image(1, 0)).toEqual({ ok: true, source: "welcome_image_credit", candyCharged: 0 })
  })

  it("credits take priority even when candy is plentiful (the parent does not choose)", () => {
    expect(image(2, 10_000)).toMatchObject({ source: "welcome_image_credit", candyCharged: 0 })
  })

  it.each<RequestKind>(["video", "drawing_animation"])("%s never uses a welcome credit", (type) => {
    expect(decideCharge({ type, welcomeCreditsRemaining: 3, candyBalance: 0, candyCost: 40 })).toEqual({
      ok: false,
      reason: "insufficient_candies",
    })
    expect(decideCharge({ type, welcomeCreditsRemaining: 3, candyBalance: 100, candyCost: 40 })).toEqual({
      ok: true,
      source: "candy",
      candyCharged: 40,
    })
  })

  it("zero credits + insufficient candy is rejected; zero credits + enough candy charges the catalog price", () => {
    expect(image(0, 11)).toEqual({ ok: false, reason: "insufficient_candies" })
    expect(image(0, 12)).toEqual({ ok: true, source: "candy", candyCharged: 12 })
  })
})

describe("creditNoticeFor (what the UI may claim)", () => {
  it("shows the remaining count for an image with credits", () => {
    expect(creditNoticeFor("image", 3)).toEqual({ show: true, remaining: 3 })
    expect(creditNoticeFor("image", 2)).toEqual({ show: true, remaining: 2 })
  })
  it("zero, unknown or invalid falls back to the candy display", () => {
    for (const r of [0, null, -1, 1.5, NaN]) expect(creditNoticeFor("image", r as number | null)).toEqual({ show: false })
  })
  it("video and drawing animation never claim eligibility, whatever the count", () => {
    expect(creditNoticeFor("video", 3)).toEqual({ show: false })
    expect(creditNoticeFor("drawing_animation", 3)).toEqual({ show: false })
  })
})

describe("normalisation helpers", () => {
  it("toPaymentSource defaults anything unknown to candy (rows that predate the column)", () => {
    expect(toPaymentSource("welcome_image_credit")).toBe("welcome_image_credit")
    for (const v of ["candy", undefined, null, "", "welcome", 1, {}]) expect(toPaymentSource(v)).toBe("candy")
  })
  it("normalizeRemaining never goes negative or non-integer", () => {
    expect(normalizeRemaining(3, 0)).toBe(3)
    expect(normalizeRemaining(3, 3)).toBe(0)
    expect(normalizeRemaining(3, 9)).toBe(0)
    expect(normalizeRemaining(3, 1.9)).toBe(2)
    expect(normalizeRemaining("3", 0)).toBe(0)
    expect(normalizeRemaining(NaN, 0)).toBe(0)
  })
})

// The Supabase reader (readWelcomeImageCredits) was removed in V0.1.46. Its
// PostgreSQL replacement is pinned by tests/unit/repositories.test.ts and the
// welcome-image-credits/parent-account cutover DB suites.

// ── Response contract ────────────────────────────────────────────────────────

describe("submission success shape", () => {
  it("reports the payment source from the row; a replay reports the ORIGINAL source", () => {
    const credit = toSubmissionSuccess({ id: OID, type: "image", status: "pending_review", candy_cost: 0, replayed: false, payment_source: "welcome_image_credit" })
    expect(credit).toMatchObject({ paymentSource: "welcome_image_credit", candyCost: 0, replayed: false })
    const replay = toSubmissionSuccess({ id: OID, type: "image", status: "pending_review", candy_cost: 0, replayed: true, payment_source: "welcome_image_credit" })
    expect(replay).toMatchObject({ paymentSource: "welcome_image_credit", replayed: true })
  })
  it("a row from a database that predates the column is candy", () => {
    expect(toSubmissionSuccess({ id: OID, type: "image", status: "x", candy_cost: 12, replayed: false })).toMatchObject({ paymentSource: "candy" })
  })
  it("exposes no ledger or internal identifiers", () => {
    const out = toSubmissionSuccess({
      id: OID, type: "image", status: "x", candy_cost: 0, replayed: false, payment_source: "welcome_image_credit",
      usage_id: "SECRET-USAGE", wallet_id: "SECRET-WALLET", parent_id: "SECRET-PARENT", granted_count: 3, used_count: 1,
    })
    expect(Object.keys(out!).sort()).toEqual(["candyCost", "orderId", "paymentSource", "replayed", "status", "success", "type"])
    expect(JSON.stringify(out)).not.toMatch(/SECRET|usage|wallet|granted|used_count/)
  })
})

// ── Routes ───────────────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  client: null as unknown,
  create: vi.fn(),
  lookup: vi.fn(),
}))
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => m.client }))
// V0.1.50: identity, consent, the idempotency lookup and the write all go
// through the backend; the payment source is decided in PostgreSQL and merely
// reported by the route (the database rule itself: welcome-credits-db.test.ts,
// request-cutover-db.test.ts).
vi.mock("@/lib/parent/backend-caller", () => ({
  verifyParentCaller: async () => ({ ok: true, context: { identity: { provider: "supabase", subject: "u1" }, authenticatedAt: 1 } }),
}))
vi.mock("@/lib/parent/consent/backend-consent", () => ({
  fetchParentConsent: async () => ({ ok: true, status: "granted", consentGrantedAt: "2026-01-01T00:00:00.000Z" }),
}))
vi.mock("@/lib/requests/backend-request", () => ({
  createRequestViaBackend: m.create,
  lookupRequestBySubmissionKey: m.lookup,
}))
vi.mock("@/lib/requests/request-submission", () => ({
  parseAndValidateDraft: () => ({
    ok: true,
    data: { type: "image", title: null, description: "SECRET-PROMPT", characterId: null, durationKey: null, durationChoice: null, videoScript: null, videoStyle: null, animationStyle: null, charactersSpeak: null, fileName: null, childName: "SECRET-CHILD" },
  }),
}))

let records: LogRecord[]
let restoreSink: () => void
const order = (candyCost: number, paymentSource: "candy" | "welcome_image_credit", replayed = false) => ({
  ok: true as const,
  confirmedBy: "write" as const,
  order: { orderId: OID, type: "image", status: "pending_review", candyCost, paymentSource, replayed },
})
beforeEach(() => {
  records = []
  restoreSink = setLogSink((r) => records.push(r))
  setRateLimitStore(new InMemoryRateLimitStore())
  m.lookup.mockReset().mockResolvedValue({ ok: true, found: false })
  m.create.mockReset().mockResolvedValue(order(0, "welcome_image_credit"))
})
afterEach(() => restoreSink())

function submitClient() {
  return { storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) } }
}

function submit() {
  const r = new Request("http://x/api/requests", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", origin: "http://localhost:3000" }, body: "x" })
  const fields: Record<string, unknown> = { draft: "{}", submissionKey: KEY, file: { size: 100, type: "image/png", name: "SECRET-FILE.png" }, sourceAssetId: null }
  ;(r as unknown as { formData: unknown }).formData = async () => ({ get: (k: string) => fields[k] ?? null })
  return r
}

describe("POST /api/requests payment source", () => {
  it("returns paymentSource for a welcome-credit order and logs it without balances or secrets", async () => {
    m.client = submitClient()
    const { POST } = await import("@/app/api/requests/route")
    const res = await POST(submit())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, orderId: OID, candyCost: 0, replayed: false, paymentSource: "welcome_image_credit" })
    expect(Object.keys(body).sort()).toEqual(["candyCost", "orderId", "paymentSource", "replayed", "status", "success", "type"])

    const accepted = records.find((r) => r.event === "SUBMISSION_ACCEPTED")!
    expect(accepted).toMatchObject({ orderId: OID, replayed: false, paymentSource: "welcome_image_credit" })
    expect(JSON.stringify(records)).not.toMatch(/SECRET|balance|11111111-1111|welcome_credits|usage/)
  })

  it("a candy-paid order reports candy", async () => {
    m.client = submitClient()
    m.create.mockResolvedValue(order(12, "candy"))
    const { POST } = await import("@/app/api/requests/route")
    const body = await (await POST(submit())).json()
    expect(body).toMatchObject({ candyCost: 12, paymentSource: "candy" })
  })

  it("a replay via the idempotency fast path reports the ORIGINAL source and spends nothing", async () => {
    m.client = submitClient()
    m.lookup.mockResolvedValue({ ok: true, found: true, order: { orderId: OID, type: "image", status: "pending_review", candyCost: 0, paymentSource: "welcome_image_credit" } })
    const { POST } = await import("@/app/api/requests/route")
    const body = await (await POST(submit())).json()
    expect(body).toMatchObject({ replayed: true, paymentSource: "welcome_image_credit", candyCost: 0 })
    expect(m.create).not.toHaveBeenCalled()
    expect(records.find((r) => r.event === "SUBMISSION_REPLAYED")).toMatchObject({ paymentSource: "welcome_image_credit", replayed: true })
  })

  it("a replay won inside the RPC (race) also reports the original source", async () => {
    m.client = submitClient()
    m.create.mockResolvedValue(order(0, "welcome_image_credit", true))
    const { POST } = await import("@/app/api/requests/route")
    const body = await (await POST(submit())).json()
    expect(body).toMatchObject({ replayed: true, paymentSource: "welcome_image_credit" })
  })

  it("insufficient balance keeps its existing safe 402 semantics", async () => {
    m.client = submitClient()
    m.create.mockResolvedValue({ ok: false, reason: "refused", error: "INSUFFICIENT_CANDIES" })
    const { POST } = await import("@/app/api/requests/route")
    const res = await POST(submit())
    expect(res.status).toBe(402)
    expect((await res.json()).code).toBe("INSUFFICIENT_CANDIES")
  })

  it("the logger allow-list only admits the two known payment sources", () => {
    expect(sanitizeFields({ paymentSource: "welcome_image_credit" })).toEqual({ paymentSource: "welcome_image_credit" })
    expect(sanitizeFields({ paymentSource: "candy" })).toEqual({ paymentSource: "candy" })
    expect(sanitizeFields({ paymentSource: "anything else" })).toEqual({})
  })
})

// GET /api/parent/welcome-credits is served by the backend since V0.1.46:
// tests/unit/parent-account-api.test.ts (BFF contract) and
// parent-account-cutover-db.test.ts (copied data, real chain).

// ── UI ───────────────────────────────────────────────────────────────────────

describe("UI", () => {
  it("billing note shows the remaining image credits, distinct from candy, image-only wording", async () => {
    const { WelcomeCreditsNote } = await import("@/components/dashboard/billing/welcome-credits-note")
    const html = renderToStaticMarkup(createElement(WelcomeCreditsNote, { remaining: 3 }))
    expect(html).toContain("اعتبار رایگان ساخت تصویر: ۳")
    expect(html).toContain("فقط برای ساخت تصویر")
    expect(html).not.toMatch(/ویدیو|متحرک|انیمیشن/) // never implies video or animation eligibility
    const after = renderToStaticMarkup(createElement(WelcomeCreditsNote, { remaining: 2 }))
    expect(after).toContain("اعتبار رایگان ساخت تصویر: ۲")
  })

  it("is hidden at zero or when unknown", async () => {
    const { WelcomeCreditsNote } = await import("@/components/dashboard/billing/welcome-credits-note")
    for (const r of [0, undefined, -1, 1.5]) {
      expect(renderToStaticMarkup(createElement(WelcomeCreditsNote, { remaining: r }))).toBe("")
    }
  })

  it("the creation review shows the free-credit notice only for image drafts and falls back to candy cost otherwise", () => {
    const src = fs.readFileSync(path.join(root, "components/creation/complete-creation-request.tsx"), "utf8")
    expect(src).toContain("این سفارش از اعتبار رایگان تصویر شما استفاده می‌کند.")
    expect(src).toContain("اعتبار رایگان ساخت تصویر:")
    // Credits are only fetched for image drafts, and the notice replaces ONLY the cost box when shown.
    expect(src).toMatch(/isImageDraft/)
    expect(src).toMatch(/!creditNotice\.show && costResult\?\.available === true/)
    // The pricing display for the other types is untouched.
    expect(src).toContain("هزینه برآوردی")
    expect(src).not.toMatch(/welcome.*(video|drawing)/i)
  })

  it("orders show 'free' instead of '0 candy' for a zero-cost (credit) order", () => {
    const card = fs.readFileSync(path.join(root, "components/dashboard/orders/parent-order-card.tsx"), "utf8")
    expect(card).toMatch(/candyCost > 0/)
    expect(card).toContain("رایگان")
  })

  it("the normal candy balance card is unchanged: still only the wallet balance", () => {
    const card = fs.readFileSync(path.join(root, "components/dashboard/billing/candy-balance-card.tsx"), "utf8")
    expect(card).not.toMatch(/welcome|اعتبار رایگان/i)
  })
})

// ── Migration (static) ───────────────────────────────────────────────────────

describe("migration 20260926100000_welcome_image_credits.sql (static review)", () => {
  const dir = path.join(root, "supabase/migrations")
  const file = "20260926100000_welcome_image_credits.sql"
  const sql = fs.readFileSync(path.join(dir, file), "utf8")

  it("is a NEW forward migration, strictly newer than every one before it", () => {
    // Later migrations are allowed only if listed here, i.e. reviewed against
    // this one. V0.1.48 recreates create_parent_request_trusted without its
    // Supabase consent clause and otherwise byte-identical to this file.
    const later = ["20261022100000_request_rpc_consent_gate_moved.sql"]
    const others = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f !== file && !later.includes(f))
    for (const f of others) expect(f < file, f).toBe(true)
    for (const f of later) expect(f > file, f).toBe(true)
  })

  it("makes the grant durable and one-time", () => {
    expect(sql).toMatch(/parent_id\s+UUID PRIMARY KEY REFERENCES public\.parent_profiles/)
    expect(sql).toContain("ON CONFLICT (parent_id) DO NOTHING")
    expect(sql).toMatch(/AFTER INSERT ON public\.parent_profiles/)
    expect(sql).toMatch(/used_count <= granted_count/)
    expect(sql).toMatch(/order_id\s+UUID NOT NULL UNIQUE/)
  })

  it("keeps welcome credits image-only and out of the candy ledger", () => {
    expect(sql).toContain("CHECK (payment_source = 'candy' OR type = 'image')")
    expect(sql).toMatch(/IF p_type = 'image' THEN\s+SELECT \(wc\.granted_count/)
    // The credit branch writes a usage row, never a candy transaction.
    const creditBranch = sql
      .slice(sql.indexOf("IF v_use_credit THEN\n        -- Guarded"), sql.indexOf("      ELSE\n        -- Candy path"))
      .replace(/--[^\n]*/g, "") // comments may mention the ledger; code must not touch it
    expect(creditBranch).toContain("parent_welcome_credit_usages")
    expect(creditBranch).not.toMatch(/candy_transactions|candy_wallets/)
  })

  it("spends atomically inside the RPC under the wallet lock, with a post-lock replay re-check", () => {
    expect(sql).toMatch(/FROM public\.candy_wallets cw[\s\S]*FOR UPDATE/)
    expect(sql).toContain("EXIT charge_and_create")
    expect(sql).toContain("RAISE EXCEPTION 'WELCOME_CREDIT_EXHAUSTED'")
  })

  it("drops and recreates the 16-arg RPC, restricts it to service_role, and never edits applied migrations", () => {
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.create_parent_request_trusted\(/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_parent_request_trusted[\s\S]*TO service_role/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.create_parent_request_trusted[\s\S]*FROM authenticated/)
  })

  it("backfills existing parent accounts once, independent of candy balance", () => {
    const backfill = sql.slice(sql.indexOf("INSERT INTO public.parent_welcome_credits (parent_id, granted_count, used_count)\nSELECT pp.id"))
    expect(backfill).toMatch(/u\.role = 'parent'/)
    expect(backfill).toMatch(/ON CONFLICT \(parent_id\) DO NOTHING/)
    expect(backfill.slice(0, backfill.indexOf("ON CONFLICT"))).not.toMatch(/balance/)
  })

  it("browser roles can read their own credits but not write", () => {
    expect(sql).toMatch(/GRANT SELECT ON public\.parent_welcome_credits TO authenticated/)
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*parent_welcome_credit/)
  })
})

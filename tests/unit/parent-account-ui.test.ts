import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CandyBalanceCard } from "@/components/dashboard/billing/candy-balance-card"
import { WelcomeCreditsNote } from "@/components/dashboard/billing/welcome-credits-note"
import { loadBilling, refreshBillingData } from "@/lib/candy-purchases/billing-client"

/**
 * Billing page regression after the V0.1.46 account-read cutover. The
 * components are unchanged; what changed is where the balance and the credits
 * come from (/api/parent/account-summary instead of /api/candy-purchases). The
 * page's browser-side loader is exercised with a fake fetch; the cards render
 * as before. (The real page in a browser against Docker: docs/ROUTE_CUTOVER.md.)
 */

const root = process.cwd()
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

const PURCHASE = {
  id: "00000000-0000-4000-8000-000000000001", packageName: "بسته کوچک", candyAmount: 20, priceAmount: 100000,
  originalPriceAmount: 100000, discountAmount: 0, finalPriceAmount: 100000, currency: "IRR", status: "paid",
  createdAt: "2026-09-01T10:00:00Z", paidAt: "2026-09-01T10:01:00Z", couponCodeSnapshot: null, couponName: null,
  couponStatus: null, paymentStarted: true,
}

type Routes = Record<string, { status: number; body: unknown }>

function fakeFetch(routes: Routes) {
  const seen: string[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    seen.push(`${String(input)} ${init?.cache}`)
    const r = routes[String(input)]
    if (!r) throw new TypeError("network")
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  return { impl, seen }
}

const healthy = (): Routes => ({
  "/api/candy-packages": { status: 200, body: { packages: [{ id: "p1", name: "بسته کوچک" }] } },
  "/api/candy-purchases": { status: 200, body: { purchases: [PURCHASE] } },
  "/api/parent/account-summary": { status: 200, body: { wallet: { balance: 37 }, welcomeImageCreditsRemaining: 2 } },
})

describe("billing page data: balance + credits from the account summary, history from purchases", () => {
  it("first load: three routes in parallel, no-store, merged into the shape the page renders", async () => {
    const { impl, seen } = fakeFetch(healthy())
    const result = await loadBilling(impl)
    expect(seen.sort()).toEqual(["/api/candy-packages no-store", "/api/candy-purchases no-store", "/api/parent/account-summary no-store"])
    expect(result).toEqual({
      kind: "ok",
      packages: [{ id: "p1", name: "بسته کوچک" }],
      billing: { wallet: { balance: 37 }, welcomeImageCreditsRemaining: 2, purchases: [PURCHASE] },
    })
  })

  it("the refresh after a purchase step reads the SAME two routes (one source for the balance)", async () => {
    const { impl, seen } = fakeFetch(healthy())
    expect(await refreshBillingData(impl)).toEqual({ wallet: { balance: 37 }, welcomeImageCreditsRemaining: 2, purchases: [PURCHASE] })
    expect(seen.sort()).toEqual(["/api/candy-purchases no-store", "/api/parent/account-summary no-store"])
  })

  it("credits unknown (field absent) -> no credits field, the note stays hidden", async () => {
    const routes = healthy()
    routes["/api/parent/account-summary"] = { status: 200, body: { wallet: { balance: 0 } } }
    const result = await loadBilling(fakeFetch(routes).impl)
    expect(result.kind === "ok" && result.billing).toEqual({ wallet: { balance: 0 }, purchases: [PURCHASE] })
  })

  it("a 401 from ANY route -> sign in again; a 403 -> login; anything else failing -> the retry card", async () => {
    for (const [route, status, kind] of [
      ["/api/parent/account-summary", 401, "session_expired"],
      ["/api/candy-purchases", 401, "session_expired"],
      ["/api/parent/account-summary", 403, "forbidden"],
      ["/api/parent/account-summary", 503, "error"],
      ["/api/parent/account-summary", 400, "error"],
      ["/api/candy-packages", 503, "error"],
    ] as const) {
      const routes = healthy()
      routes[route] = { status, body: { error: "x" } }
      expect((await loadBilling(fakeFetch(routes).impl)).kind, `${route} ${status}`).toBe(kind)
    }
    const routes = healthy()
    delete routes["/api/parent/account-summary"]
    expect((await loadBilling(fakeFetch(routes).impl)).kind).toBe("error")
  })

  it("a failed refresh keeps what is shown (null)", async () => {
    const routes = healthy()
    routes["/api/parent/account-summary"] = { status: 503, body: { error: "x" } }
    expect(await refreshBillingData(fakeFetch(routes).impl)).toBeNull()
  })

  it("the dashboard component uses this loader for both its first load and every refresh", () => {
    const src = fs.readFileSync(path.join(root, "components/dashboard/billing/candy-billing-dashboard.tsx"), "utf8")
    expect(src).toMatch(/await loadBilling\(\)/)
    expect(src).toMatch(/await refreshBillingData\(\)/)
    // Reads go only through the loader; the component still POSTs its writes itself.
    expect(src).not.toMatch(/fetch\("\/api\/candy-purchases", \{ cache/)
    expect(src).not.toMatch(/account-summary|backend|\/v1\//)
  })
})

describe("billing cards render the values as before (labels and copy unchanged)", () => {
  it("candy balance: Persian digits and the existing labels", () => {
    const out = html(createElement(CandyBalanceCard, { balance: 1250 }))
    expect(out).toContain("موجودی آبنبات")
    expect(out).toContain("۱٬۲۵۰")
    expect(out).toContain("آبنبات‌ها برای ثبت درخواست‌های ساخت محتوا استفاده می‌شوند.")
  })

  it("zero balance renders ۰, not an empty or missing card", () => {
    const out = html(createElement(CandyBalanceCard, { balance: 0 }))
    expect(out).toContain(">۰<")
  })

  it("welcome credits: shown with the image-only copy; hidden at zero or unknown", () => {
    expect(html(createElement(WelcomeCreditsNote, { remaining: 2 }))).toContain("اعتبار رایگان ساخت تصویر: ۲")
    for (const remaining of [0, undefined]) expect(html(createElement(WelcomeCreditsNote, { remaining }))).toBe("")
  })

  it("the page still renders the balance card from billingData.wallet.balance and the note from welcomeImageCreditsRemaining", () => {
    const src = fs.readFileSync(path.join(root, "components/dashboard/billing/candy-billing-dashboard.tsx"), "utf8")
    expect(src).toContain("<CandyBalanceCard balance={billingData.wallet.balance} />")
    expect(src).toContain("<WelcomeCreditsNote remaining={billingData.welcomeImageCreditsRemaining} />")
    expect(src).toContain("دریافت اطلاعات انجام نشد.")
  })
})

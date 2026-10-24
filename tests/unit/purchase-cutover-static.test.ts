import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Static guards for the V0.1.51 candy purchase / payment cutover: the wallet has
 * ONE database (PostgreSQL), purchases/coupons/payments reach it only through
 * trusted functions behind the backend, a payment is confirmed only by a
 * provider-verified event, and what did not move (order detail, gallery,
 * final media, admin fulfilment, Storage) is untouched.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "")

function walk(dir: string, pattern = /\.(ts|tsx|js|jsx|mjs)$/): string[] {
  if (!fs.existsSync(path.join(root, dir))) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel, pattern))
    else if (pattern.test(entry.name)) out.push(rel)
  }
  return out
}

const nextRuntime = [...walk("app"), ...walk("components"), ...walk("lib"), "middleware.ts"].filter((f) => !f.startsWith("lib/repositories/") && !f.startsWith("lib/db/"))
const FINANCIAL_TABLES = ["candy_purchases", "payment_attempts", "payment_webhook_events", "coupon_redemptions", "coupons", "coupon_package_rules", "candy_packages", "candy_wallets", "candy_transactions"]
const FINANCIAL_RPCS = ["complete_candy_purchase", "apply_coupon_to_purchase", "validate_coupon_for_purchase", "create_payment_attempt", "record_payment_attempt_session", "create_coupon_trusted", "update_coupon_trusted"]

describe("25/26. zero Supabase Database access for purchases, payments, coupons, packages and the wallet", () => {
  it("no Next runtime file reads or writes a financial table through Supabase", () => {
    const offenders: string[] = []
    for (const f of nextRuntime) {
      const src = code(f)
      for (const t of FINANCIAL_TABLES) if (new RegExp(`\\.from\\(\\s*["']${t}["']`).test(src)) offenders.push(`${f}: ${t}`)
    }
    expect(offenders).toEqual([])
  })

  it("no Next runtime file calls a purchase/coupon/payment RPC", () => {
    const offenders = nextRuntime.filter((f) => FINANCIAL_RPCS.some((r) => new RegExp(`\\.rpc\\(\\s*["']${r}`).test(code(f))))
    expect(offenders).toEqual([])
  })

  it("the purchase, coupon, pay, webhook, return, package and admin coupon routes import no Supabase client", () => {
    for (const f of [
      "app/api/candy-purchases/route.ts", "app/api/candy-purchases/[id]/coupon/route.ts", "app/api/candy-purchases/[id]/pay/route.ts",
      "app/api/coupons/validate/route.ts", "app/api/candy-packages/route.ts", "app/api/payments/webhooks/[provider]/route.ts",
      "app/api/payments/return/[provider]/route.ts", "app/api/admin/coupons/route.ts", "app/api/admin/coupons/[id]/route.ts",
      "lib/admin/coupons/queries.ts", "lib/admin/coupons/service.ts", "lib/candy-purchases/backend-purchases.ts",
    ]) {
      expect(code(f), f).not.toMatch(/@\/lib\/supabase|createServerSupabaseClient|createAdminSupabaseClient|@supabase\//)
    }
  })

  it("the development 'simulated completion' route and its UI are gone", () => {
    expect(fs.existsSync(path.join(root, "app/api/candy-purchases/[id]/complete/route.ts"))).toBe(false)
    for (const f of nextRuntime) expect(code(f), f).not.toMatch(/CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION|\/complete`|enableDevPaymentSimulation/)
  })
})

describe("31. the wallet is credited ONLY by a provider-verified event", () => {
  it("only confirm_payment_attempt_trusted (and the historical function) credit the wallet for a purchase; no repository writes a table", () => {
    const sql = read("database/migrations/0017_candy_purchase_payment.sql")
    const credit = [...sql.matchAll(/CREATE (OR REPLACE )?FUNCTION public\.([a-z_]+)\([\s\S]*?\n\$(?:_)?\$;/g)]
      .filter((m) => /UPDATE public\.candy_wallets SET balance = balance \+/.test(m[0])).map((m) => m[2])
    expect(credit).toEqual(["confirm_payment_attempt_trusted"])
    // The financial repositories write only through functions (parent-profiles keeps its V0.1.47 name UPDATE).
    for (const f of ["lib/repositories/candy-purchases.ts", "lib/repositories/admin-coupons.ts", "lib/repositories/parent-requests.ts", "lib/repositories/candy-wallets.ts", "lib/repositories/welcome-credits.ts"]) {
      expect(code(f), f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM)\b/i)
    }
  })

  it("the provider-event route requires a SERVICE assertion; no parent route reaches the confirm/fail functions", () => {
    const events = code("backend/src/routes/payment-events.ts")
    expect(events).toMatch(/app\.post\(PAYMENT_EVENTS_PATH, \{ preHandler: \[requireServiceAuth\(deps, "payments"\)\] \}/)
    expect(events).not.toMatch(/requireAuth|requireWriteAuth|authPrincipal/)
    const users = [...walk("backend/src"), ...walk("lib")].filter((f) => /confirmPaymentEvent|failPaymentEvent/.test(code(f)) && f !== "lib/repositories/candy-purchases.ts")
    expect(users).toEqual(["backend/src/routes/payment-events.ts"])
  })

  it("only the webhook and return routes hand provider events to the backend, and only after the provider verified them", () => {
    const callers = nextRuntime.filter((f) => /deliverProviderEvent\(/.test(code(f)) && f !== "lib/candy-purchases/backend-purchases.ts")
    expect(callers.sort()).toEqual(["app/api/payments/return/[provider]/route.ts", "app/api/payments/webhooks/[provider]/route.ts"])
    const hook = code("app/api/payments/webhooks/[provider]/route.ts")
    expect(hook.indexOf("verifyWebhook(raw, request.headers)")).toBeGreaterThan(-1)
    expect(hook.indexOf("verifyWebhook(")).toBeLessThan(hook.indexOf("deliverProviderEvent("))
    expect(hook).toMatch(/if \(!verified\.ok\) \{[\s\S]*?status: 401/)
    const ret = code("app/api/payments/return/[provider]/route.ts")
    expect(ret.indexOf("verifySession(session)")).toBeLessThan(ret.indexOf("deliverProviderEvent("))
    // The return route never turns query parameters into a result.
    expect(ret).not.toMatch(/searchParams\.get\("(status|amount|paid|transaction)/)
    const service = nextRuntime.filter((f) => /backendServiceWriteJson\(/.test(code(f)) && f !== "lib/backend/client.ts")
    expect(service).toEqual(["lib/candy-purchases/backend-purchases.ts"])
  })

  it("provider routes are NOT browser routes: no CSRF guard, no Supabase session; the webhook does not even read cookies", () => {
    for (const f of ["app/api/payments/webhooks/[provider]/route.ts", "app/api/payments/return/[provider]/route.ts"]) {
      expect(code(f), f).not.toMatch(/rejectUnsafeBrowserWrite|verifyParentCaller|verifySupabaseIdentity|cookies\(/)
    }
  })

  it("the stub provider refuses production unless explicitly forced, and the registry resolves only the configured provider", () => {
    const stub = code("lib/payments/providers/stub.ts")
    expect(stub).toMatch(/env\.NODE_ENV === "production" && env\.CARTOONA_PAYMENT_STUB_UNSAFE_ALLOW_IN_PRODUCTION !== "1"\) return null/)
    expect(stub).toMatch(/timingSafeEqual/)
    expect(code("lib/payments/providers/registry.ts")).toMatch(/adapter && adapter\.id === pathId \? adapter : null/)
  })
})

describe("8/31. the browser cannot choose price, amount, wallet, owner or status", () => {
  it("the billing UI sends only a package id, a coupon code + key, or a pay key", () => {
    const ui = [...walk("components/dashboard/billing")].map(code).join("\n")
    const bodies = [...ui.matchAll(/body: JSON\.stringify\(\{([^}]*)\}\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim())
    expect(bodies.sort()).toEqual(["code: normalized, idempotency_key: applyKeyRef.current", "idempotency_key: key", "package_id: selectedPkg.id", "purchase_id: purchase.id, code: normalized"].sort())
  })

  it("the backend purchase routes take the caller only from the principal and accept exact keys", () => {
    const r = code("backend/src/routes/candy-purchases.ts")
    expect(r).toMatch(/exactKeys\(request\.body, \["packageId"\]\)/)
    expect(r).toMatch(/exactKeys\(request\.body, \["code", "idempotencyKey"\]\)/)
    expect(r).toMatch(/exactKeys\(request\.body, \["provider", "idempotencyKey", "checkoutExpiresAt"\]\)/)
    expect(r).toMatch(/findParentProfileIdByUserId\(deps\.db\(\), \{ userId: request\.authPrincipal!\.userId \}\)/)
    expect(r).not.toMatch(/request\.(headers|cookies)|x-user-id|parentProfileId:\s*body|priceAmount|candyAmount/i)
  })
})

describe("29/30. scope: what did NOT move", () => {
  it("order detail, final media and gallery still read Supabase; admin fulfilment never reaches the backend", () => {
    expect(code("lib/parent/orders/detail-queries.ts")).toMatch(/SupabaseClient/)
    expect(code("lib/parent/orders/final-media-queries.ts")).toMatch(/SupabaseClient/)
    expect(code("app/api/parent/gallery/route.ts")).not.toMatch(/@\/lib\/backend/)
    for (const f of [...walk("app/api/admin/requests"), ...walk("app/admin/requests"), ...walk("lib/admin/requests")]) {
      expect(code(f), f).not.toMatch(/@\/lib\/backend|backend-caller/)
    }
  })

  it("Storage is untouched: no backend Storage code, no blob columns, request uploads still go to Supabase Storage", () => {
    for (const f of walk("backend/src")) expect(code(f), f).not.toMatch(/storage\.from|@supabase|bytea/i)
    expect(read("database/migrations/0017_candy_purchase_payment.sql")).not.toMatch(/bytea|large object|lo_import/i)
    expect(code("app/api/requests/route.ts")).toMatch(/supabase\.storage\s*\.from\("parent-uploads"\)/)
  })

  it("request submission is still PostgreSQL-backed", () => {
    expect(code("app/api/requests/route.ts")).toMatch(/createRequestViaBackend\(context, payload\)/)
  })
})

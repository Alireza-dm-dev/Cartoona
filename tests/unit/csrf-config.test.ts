import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/observability/request-context", () => ({ log: () => {} }))

import { checkBrowserWrite, expectedOrigins } from "@/lib/security/csrf"

/**
 * V0.1.49 CARTOONA_APP_ORIGIN configuration rules (lib/security/csrf.ts),
 * beyond the V0.1.48 matrix in csrf.test.ts. Normalization is deliberately
 * NONE: a configured value must already be the canonical origin
 * (scheme://host[:non-default-port], lowercase host, no slash, no path).
 * Anything else is a misconfiguration and fails closed for every write -
 * deterministic, never "close enough".
 */

const APP = "https://cartoona.example"
const good = { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" }
const req = (headers: Record<string, string> = good) =>
  new Request(`${APP}/api/parent/account-setup`, { method: "POST", headers, body: "{}" })
const prod = (origin?: string) => ({ NODE_ENV: "production", ...(origin === undefined ? {} : { CARTOONA_APP_ORIGIN: origin }) })

describe("production", () => {
  it.each([[undefined], [""], ["   "]])("unset/empty (%j) -> every guarded write 503 csrf_not_configured", (origin) => {
    expect(expectedOrigins(prod(origin))).toBeNull()
    expect(checkBrowserWrite(req(), prod(origin))).toEqual({ status: 503, code: "csrf_not_configured", reason: "config" })
  })

  it("a canonical origin is accepted exactly", () => {
    expect(expectedOrigins(prod(APP))).toEqual([APP])
    expect(checkBrowserWrite(req(), prod(APP))).toBeNull()
  })
})

describe("normalization is refused, not applied (fails closed)", () => {
  it.each([
    ["trailing slash", "https://cartoona.example/"],
    ["default https port", "https://cartoona.example:443"],
    ["default http port", "http://cartoona.example:80"],
    ["uppercase host", "https://Cartoona.example"],
    ["path", "https://cartoona.example/app"],
    ["query", "https://cartoona.example?x=1"],
    ["credentials", "https://user@cartoona.example"],
    ["no scheme", "cartoona.example"],
    ["non-http scheme", "ftp://cartoona.example"],
    ["the literal null", "null"],
    ["empty list entry", `${APP},,https://www.cartoona.example`],
    ["one bad entry poisons the list", `${APP},https://www.cartoona.example/`],
  ])("%s: %s", (_label, value) => {
    expect(expectedOrigins(prod(value))).toBeNull()
    expect(checkBrowserWrite(req(), prod(value))?.status).toBe(503)
  })

  it("only surrounding whitespace is trimmed (per entry), deterministically", () => {
    expect(expectedOrigins(prod(`  ${APP} ,  https://www.cartoona.example  `))).toEqual([APP, "https://www.cartoona.example"])
  })

  it("a non-default port is part of the origin and must match exactly", () => {
    const env = prod("https://cartoona.example:8443")
    expect(checkBrowserWrite(req({ ...good, origin: "https://cartoona.example:8443" }), env)).toBeNull()
    expect(checkBrowserWrite(req(good), env)?.status).toBe(403)
  })

  it("a browser Origin carrying a default port or trailing slash is malformed (browsers never send either)", () => {
    for (const origin of [`${APP}:443`, `${APP}/`]) {
      expect(checkBrowserWrite(req({ ...good, origin }), prod(APP))).toEqual({ status: 403, code: "csrf_rejected", reason: "origin_malformed" })
    }
  })
})

describe("local / test configuration is explicit", () => {
  it.each(["development", "test", undefined])("NODE_ENV=%s unset -> exactly http://localhost:3000 and http://127.0.0.1:3000", (nodeEnv) => {
    expect(expectedOrigins(nodeEnv ? { NODE_ENV: nodeEnv } : {})).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"])
  })

  it("an explicit value outside production replaces the defaults (no merge)", () => {
    const env = { NODE_ENV: "development", CARTOONA_APP_ORIGIN: "http://localhost:3100" }
    expect(expectedOrigins(env)).toEqual(["http://localhost:3100"])
    expect(checkBrowserWrite(req({ ...good, origin: "http://localhost:3000" }), env)?.status).toBe(403)
  })
})

describe("never inferred from the request", () => {
  it("Host / X-Forwarded-Host / X-Forwarded-Proto equal to a hostile Origin change nothing, in production and dev", () => {
    const hostile = "https://evil.example"
    const headers = { ...good, origin: hostile, host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }
    expect(checkBrowserWrite(req(headers), prod(APP))?.status).toBe(403)
    expect(checkBrowserWrite(req(headers), prod())?.status).toBe(503)
    expect(checkBrowserWrite(req(headers), { NODE_ENV: "development" })?.status).toBe(403)
  })
})

import { describe, it, expect, vi, beforeEach } from "vitest"

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>)
vi.mock("@/lib/observability/request-context", () => ({
  log: (_level: string, event: string, fields: Record<string, unknown>) => logs.push({ event, fields }),
}))

import { checkBrowserWrite, expectedOrigins, isJsonContentType, rejectUnsafeBrowserWrite } from "@/lib/security/csrf"

/**
 * V0.1.48 shared browser -> Next CSRF guard (lib/security/csrf.ts): the full
 * request matrix, the configuration rules, and what the response leaks.
 */

const APP = "https://cartoona.example"
const PROD = { NODE_ENV: "production", CARTOONA_APP_ORIGIN: APP }

function req(headers: Record<string, string>, method = "POST", url = `${APP}/api/parent-consent`) {
  return new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }) })
}

const good = { "content-type": "application/json", origin: APP, "sec-fetch-site": "same-origin" }
const without = (key: keyof typeof good) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== key))

beforeEach(() => {
  logs.length = 0
})

describe("allowed", () => {
  it("correct Origin + Sec-Fetch-Site same-origin + application/json", () => {
    expect(checkBrowserWrite(req(good), PROD)).toBeNull()
  })

  it.each([
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    'application/json; charset="utf-8"',
    "Application/JSON",
  ])("content type %j", (type) => {
    expect(checkBrowserWrite(req({ ...good, "content-type": type }), PROD)).toBeNull()
  })

  it("no Sec-Fetch-Site (older browser) is decided by Origin alone", () => {
    expect(checkBrowserWrite(req(without("sec-fetch-site")), PROD)).toBeNull()
  })

  it.each(["PUT", "PATCH", "DELETE"])("%s is guarded the same way", (method) => {
    expect(checkBrowserWrite(req(good, method), PROD)).toBeNull()
    expect(checkBrowserWrite(req({ ...good, origin: "https://evil.example" }, method), PROD)?.status).toBe(403)
  })
})

describe("rejected", () => {
  it.each([
    ["hostile Origin", { origin: "https://evil.example" }, "origin_mismatch"],
    ["look-alike Origin (suffix)", { origin: "https://cartoona.example.evil.example" }, "origin_mismatch"],
    ["other port", { origin: "https://cartoona.example:8443" }, "origin_mismatch"],
    ["other scheme", { origin: "http://cartoona.example" }, "origin_mismatch"],
    ["malformed Origin", { origin: "not a url" }, "origin_malformed"],
    ["Origin null (sandboxed / opaque)", { origin: "null" }, "origin_malformed"],
    ["Origin with a path", { origin: `${APP}/x` }, "origin_malformed"],
    ["Origin with a trailing slash", { origin: `${APP}/` }, "origin_malformed"],
    ["Origin with credentials", { origin: "https://u:p@cartoona.example" }, "origin_malformed"],
    ["non-http Origin", { origin: "javascript:alert(1)" }, "origin_malformed"],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }, "fetch_site"],
    ["Sec-Fetch-Site same-site (sibling subdomain)", { "sec-fetch-site": "same-site" }, "fetch_site"],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }, "fetch_site"],
  ])("%s -> 403", (_label, override, reason) => {
    expect(checkBrowserWrite(req({ ...good, ...override }), PROD)).toEqual({ status: 403, code: "csrf_rejected", reason })
  })

  it("missing Origin on a browser-like write -> 403 (every current browser sends Origin on POST)", () => {
    expect(checkBrowserWrite(req(without("origin")), PROD)).toEqual({ status: 403, code: "csrf_rejected", reason: "origin_missing" })
    // ... even with a same-origin Sec-Fetch-Site: never trusted alone.
    expect(checkBrowserWrite(req({ "content-type": "application/json", "sec-fetch-site": "same-origin" }), PROD)?.status).toBe(403)
  })

  it.each([
    ["form post", "application/x-www-form-urlencoded"],
    ["multipart form", "multipart/form-data; boundary=x"],
    ["text/plain", "text/plain"],
    ["text/plain claiming json", "text/plain; charset=application/json"],
    ["json with another charset", "application/json; charset=latin1"],
    ["json with an unknown parameter", "application/json; foo=bar"],
    ["json-ish type", "application/json-patch+json"],
    ["vendor json", "application/vnd.api+json"],
    ["empty", ""],
  ])("%s -> 415", (_label, type) => {
    expect(checkBrowserWrite(req({ ...good, "content-type": type }), PROD)).toEqual({ status: 415, code: "unsupported_media_type", reason: "content_type" })
  })

  it("no Content-Type -> 415", () => {
    const r = new Request(`${APP}/api/parent-consent`, { method: "POST", headers: { origin: APP }, body: new Uint8Array([123, 125]) })
    expect(checkBrowserWrite(r, PROD)?.status).toBe(415)
  })
})

describe("the expected origin is configured, never taken from the request", () => {
  it("forged X-Forwarded-Host / Host / Forwarded / Referer cannot make a hostile Origin acceptable", () => {
    const hostile = "https://evil.example"
    const forged = {
      ...good,
      origin: hostile,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      forwarded: "host=evil.example;proto=https",
      referer: `${hostile}/page`,
    }
    expect(checkBrowserWrite(req(forged, "POST", `${hostile}/api/parent-consent`), PROD)?.reason).toBe("origin_mismatch")
  })

  it("a matching X-Forwarded-Host is not needed for the real origin either", () => {
    expect(checkBrowserWrite(req({ ...good, "x-forwarded-host": "evil.example" }), PROD)).toBeNull()
  })

  it("production without CARTOONA_APP_ORIGIN fails closed (503), even for a same-origin request", () => {
    expect(checkBrowserWrite(req(good), { NODE_ENV: "production" })).toEqual({ status: 503, code: "csrf_not_configured", reason: "config" })
  })

  it("an invalid configured origin fails closed", () => {
    for (const bad of ["cartoona.example", "https://cartoona.example/", "https://a.example,ftp://b.example"]) {
      expect(expectedOrigins({ NODE_ENV: "production", CARTOONA_APP_ORIGIN: bad }), bad).toBeNull()
    }
  })

  it("a comma-separated list is honoured exactly", () => {
    const env = { NODE_ENV: "production", CARTOONA_APP_ORIGIN: `${APP}, https://www.cartoona.example` }
    expect(checkBrowserWrite(req({ ...good, origin: "https://www.cartoona.example" }), env)).toBeNull()
    expect(checkBrowserWrite(req({ ...good, origin: "https://api.cartoona.example" }), env)?.status).toBe(403)
  })

  it("outside production the default is localhost:3000 only - not any localhost port", () => {
    const dev = { NODE_ENV: "development" }
    expect(checkBrowserWrite(req({ ...good, origin: "http://localhost:3000" }), dev)).toBeNull()
    expect(checkBrowserWrite(req({ ...good, origin: "http://127.0.0.1:3000" }), dev)).toBeNull()
    expect(checkBrowserWrite(req({ ...good, origin: "http://localhost:8080" }), dev)?.status).toBe(403)
  })
})

describe("scope", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("%s passes untouched, whatever its headers", (method) => {
    expect(checkBrowserWrite(req({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }, method), PROD)).toBeNull()
  })

  it("isJsonContentType is exact", () => {
    expect(isJsonContentType("application/json")).toBe(true)
    expect(isJsonContentType(null)).toBe(false)
    expect(isJsonContentType("application/jsonp")).toBe(false)
  })
})

describe("the response", () => {
  it("is no-store JSON with a code; logged by category only (never the Origin)", async () => {
    const res = rejectUnsafeBrowserWrite(req({ ...good, origin: "https://evil.example" }), PROD)!
    expect(res.status).toBe(403)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toMatchObject({ code: "csrf_rejected" })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ event: "CSRF_REJECTED", fields: { status: 403, errorCode: "csrf_rejected", reason: "origin_mismatch" } })
    expect(JSON.stringify(logs)).not.toContain("evil")
  })

  it("null when allowed", () => {
    expect(rejectUnsafeBrowserWrite(req(good), PROD)).toBeNull()
    expect(logs).toHaveLength(0)
  })
})

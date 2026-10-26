import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { checkBrowserWrite, isWriteFrozen } from "@/lib/security/csrf"

/**
 * V0.1.55 WRITE-FREEZE COVERAGE. CARTOONA_WRITE_FREEZE=1 must stop every runtime
 * business write. The only entry points that can change business data are:
 *
 *   1. Next route handlers exporting POST/PUT/PATCH/DELETE (browser-facing), and
 *   2. the payment webhook (provider-facing, not a browser request).
 *
 * The Fastify backend is reachable only from Next with a signed assertion and is
 * deliberately NOT freeze-aware: freezing the one door in front of it is the
 * contract. So this test enumerates every mutating route in app/, requires the
 * freeze-aware guard in each, requires it to run BEFORE the body is read, and
 * pins the set of modules allowed to call the backend write client and the
 * absence of server actions (which would be a second, unguarded door).
 * Exemptions are explicit with a reason.
 */

const root = process.cwd()
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  const full = path.join(root, dir)
  if (!fs.existsSync(full)) return out
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, match, out)
    else if (match.test(e.name)) out.push(rel)
  }
  return out
}

const MUTATING = /export\s+(?:const|async function|function)\s+(POST|PUT|PATCH|DELETE)\b|export\s*\{[^}]*\bas\s+(POST|PUT|PATCH|DELETE)\b/
const routes = walk("app", /^route\.ts$/).filter((f) => MUTATING.test(read(f))).sort()

/** route -> why it is outside the browser-write guard. */
const EXEMPT: Record<string, string> = {
  "app/api/logout/route.ts": "ends the caller's own Auth session; no business data (Auth is outside the freeze)",
  "app/api/dev/parent-auth/route.ts": "development sign-in; 404 unless DEV_PARENT_AUTH_ENABLED, refused in production",
  "app/api/payments/webhooks/[provider]/route.ts": "provider-facing; guarded by isWriteFrozen() instead (checked below)",
}

describe("write-freeze coverage (V0.1.55)", () => {
  it("finds the mutating routes (the enumeration itself is not empty)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(25)
    for (const f of Object.keys(EXEMPT)) expect(routes, f).toContain(f)
  })

  it.each(routes.filter((f) => !EXEMPT[f]))("%s calls the freeze-aware guard before reading the body", (file) => {
    const src = code(file)
    const guard = src.indexOf("rejectUnsafeBrowserWrite(")
    expect(guard, "rejectUnsafeBrowserWrite is called").toBeGreaterThan(-1)
    const firstBodyRead = [".json()", ".formData()", ".text()", ".arrayBuffer()"].map((m) => src.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
    if (firstBodyRead !== undefined) expect(guard, "guard precedes the first body read").toBeLessThan(firstBodyRead)
  })

  it("the payment webhook refuses while frozen before it reads the body", () => {
    const src = code("app/api/payments/webhooks/[provider]/route.ts")
    const frozen = src.indexOf("isWriteFrozen()")
    expect(frozen).toBeGreaterThan(-1)
    expect(frozen).toBeLessThan(src.indexOf("request.text()"))
    expect(src).toMatch(/isWriteFrozen\(\)\)\s*return NextResponse\.json\(\{ error: "retry" \}, \{ status: 503/)
  })

  it("only the known modules call the backend write client; no server actions exist", () => {
    const callers = [...walk("app", /\.(ts|tsx)$/), ...walk("lib", /\.(ts|tsx)$/), ...walk("components", /\.(ts|tsx)$/)]
      .filter((f) => /backendWriteJson\(/.test(code(f)) && !/export (async )?function backendWriteJson/.test(code(f)))
      .sort()
    expect(callers).toEqual([
      "lib/admin/coupons/service.ts",
      "lib/admin/requests/backend-requests.ts",
      "lib/backend/call.ts",
      "lib/candy-purchases/backend-purchases.ts",
      "lib/parent/account-setup/backend-provision.ts",
      "lib/parent/backend-media.ts",
      "lib/parent/consent/backend-consent.ts",
      "lib/requests/backend-request.ts",
    ])
    const actions = [...walk("app", /\.(ts|tsx)$/), ...walk("lib", /\.(ts|tsx)$/), ...walk("components", /\.(ts|tsx)$/)].filter((f) => /^\s*["']use server["']/m.test(read(f)))
    expect(actions).toEqual([])
  })

  it("while frozen every mutating method answers 503 write_freeze, before content type or origin are examined", () => {
    const env = { CARTOONA_WRITE_FREEZE: "1", CARTOONA_APP_ORIGIN: "https://app.example", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const body of ["json", "multipart"] as const) {
        const request = new Request("https://app.example/api/x", { method, headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: "x" })
        expect(checkBrowserWrite(request, env, body)).toEqual({ status: 503, code: "write_freeze", reason: "freeze" })
      }
    }
  })

  it("reads stay open and only the exact value 1 freezes", () => {
    const frozen = { CARTOONA_WRITE_FREEZE: "1" } as unknown as NodeJS.ProcessEnv
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(checkBrowserWrite(new Request("https://app.example/x", { method }), frozen)).toBeNull()
    for (const v of ["", "0", "true", "yes", " 1", "on"]) expect(isWriteFrozen({ CARTOONA_WRITE_FREEZE: v } as unknown as NodeJS.ProcessEnv), v).toBe(false)
    expect(isWriteFrozen(frozen)).toBe(true)
  })

  it("health and readiness are not behind the guard", () => {
    for (const f of walk("app", /^route\.ts$/).filter((f) => /health|ready/.test(f))) expect(read(f)).not.toMatch(/rejectUnsafeBrowserWrite|isWriteFrozen/)
  })
})

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/** V0.1.53 static guards for the referral, homepage-CMS and examples-CMS routes (no database). */

const root = process.cwd()
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else if (/\.ts$/.test(e.name)) out.push(rel)
  }
  return out
}

const BACKEND = ["backend/src/routes/referrals.ts", "backend/src/routes/homepage.ts", "backend/src/routes/examples.ts"]
const WRITE_ROUTES = [
  ...walk("app/api/admin/homepage"), ...walk("app/api/admin/examples"),
  "app/api/referrals/bind/route.ts", "app/api/admin/referrals/settings/route.ts",
].filter((f) => /route\.ts$/.test(f))

describe("backend routes", () => {
  it("the caller is the principal; nothing identity-like is read from the request", () => {
    for (const f of BACKEND) {
      const src = code(f)
      expect(src, f).not.toMatch(/request\.headers|request\.cookies|x-role|x-user-id|body\.(userId|adminUserId|actorId|parentProfileId|referrerId|parentId)/i)
      expect(src.match(/request\.authPrincipal!\.userId/g)?.length ?? 0, f).toBeGreaterThan(0)
    }
  })

  it("every write needs requireWriteAuth with the right roles; admin reads need an admin role; only the public reads are anonymous", () => {
    const referrals = code(BACKEND[0])
    expect(referrals).toMatch(/requireWriteAuth\(deps, "parent"\)/)
    expect(referrals.match(/requireWriteAuth\(deps, "admin", "super_admin"\)/g)).toHaveLength(1)
    expect(referrals).toMatch(/requireRole\("parent"\)/)
    for (const f of BACKEND.slice(1)) {
      const src = code(f)
      for (const m of src.matchAll(/app\.(put|post|patch|delete)\([^{]*\{[^}]*preHandler:\s*\[([^\]]*)\]/g)) {
        expect(m[2], `${f} ${m[1]}`).toBe('requireWriteAuth(deps, "admin", "super_admin")')
      }
    }
    const anonymous = BACKEND.flatMap((f) => [...code(f).matchAll(/app\.get\(\s*"([^"]+)",\s*async/g)].map((m) => m[1])).sort()
    expect(anonymous).toEqual(["/v1/public/examples", "/v1/public/homepage"])
  })

  it("the backend holds no Storage code: it relays keys, never bytes", () => {
    for (const f of BACKEND) expect(code(f), f).not.toMatch(/@supabase|\.storage\b|bucket|createSignedUrl|upload\(/i)
  })

  it("every body is exact-key checked and size-limited", () => {
    for (const f of BACKEND) {
      const src = code(f)
      const writes = src.match(/app\.(put|post|patch|delete)\(/g) ?? []
      const limited = src.match(/bodyLimit:/g) ?? []
      expect(limited.length, f).toBe(writes.length)
    }
  })
})

describe("Next write routes", () => {
  it("the shared CSRF guard comes first, before any session, backend or storage work", () => {
    for (const f of WRITE_ROUTES) {
      const src = code(f)
      const guards = [...src.matchAll(/rejectUnsafeBrowserWrite\(/g)].length
      const writes = [...src.matchAll(/export (async function|const) (POST|PUT|PATCH|DELETE)\b/g)].length
      expect(guards, f).toBeGreaterThanOrEqual(writes)
    }
    for (const f of WRITE_ROUTES) {
      for (const [, fn] of code(f).matchAll(/export async function (POST|PUT|PATCH|DELETE)[^{]*\{([\s\S]*?)(?=\nexport |$)/g).map((m) => [m[1], m[2]] as const)) {
        const firstWork = Math.min(...["verifiedCaller(", "requireAdminHomepageAuth(", "request.formData(", "request.text(", "request.json(", "resolveCallerRole("].map((t) => (fn.includes(t) ? fn.indexOf(t) : Infinity)))
        expect(fn.indexOf("rejectUnsafeBrowserWrite("), f).toBeGreaterThanOrEqual(0)
        expect(fn.indexOf("rejectUnsafeBrowserWrite("), f).toBeLessThan(firstWork)
      }
    }
  })

  it("byte-storing routes ask the admin gate BEFORE storing a byte", () => {
    const media = code("lib/admin/homepage/media-service.ts")
    expect(media.indexOf("requireCmsAdmin(")).toBeGreaterThan(-1)
    expect(media.indexOf("requireCmsAdmin(")).toBeLessThan(media.indexOf("uploadHomepageMedia("))
    for (const f of ["app/api/admin/examples/route.ts", "app/api/admin/examples/[exampleId]/media/route.ts"]) {
      const src = code(f)
      expect(src.indexOf("exampleAdminGate("), f).toBeGreaterThan(-1)
      expect(src.indexOf("exampleAdminGate("), f).toBeLessThan(src.indexOf("uploadExampleImage("))
    }
  })

  it("a definite refusal removes the uploaded object; an unknown outcome keeps it", () => {
    expect(code("app/api/admin/examples/route.ts")).toMatch(/outcomeUnknown\)\) await removeExampleImage/)
    expect(code("lib/admin/homepage/media-service.ts")).toMatch(/if \(!f\.unknown\)/)
  })

  it("every homepage CMS route (reads included) asks the admin gate inside requireAdminHomepageAuth, before a body is parsed", () => {
    const svc = code("lib/admin/homepage/service.ts")
    const fn = svc.slice(svc.indexOf("export async function requireAdminHomepageAuth"), svc.indexOf("export async function requireCmsAdmin"))
    expect(fn).toMatch(/requireCmsAdmin\(caller\.context\)/)
    for (const f of walk("app/api/admin/homepage").filter((x) => /route\.ts$/.test(x))) expect(code(f), f).toMatch(/requireAdminHomepageAuth\(\)/)
  })
})

describe("referrals carry no reward effect", () => {
  it("no function or route credits a wallet for a referral (the schema has only a binding and a program setting)", () => {
    for (const f of walk("database/migrations").filter((x) => x.endsWith(".sql"))) {
      const sql = read(f).replace(/--.*$/gm, "")
      expect(sql, f).not.toMatch(/candy_transactions[\s\S]{0,400}referral_(relationship|reward)|referral_reward/i)
    }
    for (const f of [...walk("backend/src"), ...walk("lib/repositories")]) {
      expect(code(f), f).not.toMatch(/referral[\s\S]{0,200}(INSERT INTO public\.candy_transactions|UPDATE public\.candy_wallets)/i)
    }
  })

  it("the browser-facing bind body is exactly { code }", () => {
    expect(code("app/api/referrals/bind/route.ts")).toMatch(/keys\.length !== 1 \|\| keys\[0\] !== "code"/)
    expect(code("backend/src/routes/referrals.ts")).toMatch(/Object\.keys\(body\)\.length !== 1/)
  })
})

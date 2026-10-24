import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Static guards for the V0.1.48 consent cutover: consent is read and written
 * ONLY through PostgreSQL (via the backend), the one browser-facing write goes
 * through the shared CSRF guard and a v3 assertion, and nothing else moved
 * (request creation, money, media and Storage stay where they were).
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "")
const sqlCode = (p: string) => read(p).replace(/--.*$/gm, "")

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

/** Everything that runs in Next (server or browser), including middleware. */
const nextRuntime = [...walk("app"), ...walk("components"), ...walk("lib"), "middleware.ts"]
  .filter((f) => !f.startsWith("lib/repositories/") && !f.startsWith("lib/db/"))
const backendRuntime = walk("backend/src")

describe("runtime Supabase consent DB access is zero", () => {
  it("no Next runtime file names a consent column", () => {
    const offenders = nextRuntime.filter((f) => /consent_granted/.test(code(f)))
    expect(offenders).toEqual([])
  })

  it("every remaining Supabase parent_profiles query selects no consent (and the request route reads no Supabase table at all)", () => {
    for (const f of nextRuntime) {
      for (const m of code(f).matchAll(/\.from\(["']parent_profiles["']\)([\s\S]{0,200})/g)) {
        expect(m[1], f).not.toMatch(/consent/i)
      }
    }
    // V0.1.50: the profile id is resolved by the backend from the assertion.
    expect(code("app/api/requests/route.ts")).not.toMatch(/\.from\(["'](?!parent-uploads)/)
  })

  it("the only code that names consent columns is the PostgreSQL repository and migrations", () => {
    const repo = code("lib/repositories/parent-profiles.ts")
    expect(repo).toMatch(/SELECT p\.consent_granted, p\.consent_granted_at\s+FROM public\.parent_profiles p\s+WHERE p\.user_id = \$1/)
    expect(repo).toMatch(/FROM public\.record_parent_consent_trusted\(\$1\)/)
    // The repository never UPDATEs consent directly: the app role cannot.
    expect(repo).not.toMatch(/SET consent/)
  })

  it("middleware no longer reads parent_profiles at all (Edge runtime; the page is the gate)", () => {
    expect(code("middleware.ts")).not.toMatch(/parent_profiles|consent_granted/)
  })

  it("signup and the dev route create profiles without consent columns", () => {
    expect(code("lib/parent/ensure-parent-profile.ts")).not.toMatch(/consent/i)
    expect(code("app/api/parent/complete-signup/route.ts")).not.toMatch(/consent:/)
  })
})

describe("every consent decision uses the one PostgreSQL-backed loader", () => {
  it.each([
    ["app/(auth)/parent-consent/page.tsx", /loadParentConsent\(\)/],
    ["app/(auth)/complete-request/page.tsx", /loadParentConsent\(\)/],
    ["app/api/requests/route.ts", /fetchParentConsent\(context\)/],
    ["app/api/parent-consent/route.ts", /grantParentConsent\(caller\.context\)/],
    ["app/api/dev/parent-auth/route.ts", /fetchParentConsent\(verification\.context\)/],
  ])("%s", (file, pattern) => {
    expect(code(file)).toMatch(pattern)
  })

  it("/login decides through GET /api/parent-consent (the BFF), never Supabase or the backend", () => {
    const login = code("app/(auth)/login/page.tsx")
    expect(login).toMatch(/readParentConsent\(\)/)
    expect(login).not.toMatch(/parent_profiles|backend|:4000|\/v1\//)
    const client = code("lib/parent/consent/consent-client.ts")
    expect(client).toMatch(/fetchImpl\("\/api\/parent-consent"/)
    expect(client).not.toMatch(/backend|:4000|\/v1\/|supabase/i)
  })

  it("the browser consent form posts to Next only", () => {
    const form = code("app/(auth)/parent-consent/parent-consent-form.tsx")
    expect(form).toMatch(/fetch\("\/api\/parent-consent", \{\s*method: "POST"/)
    expect(form).not.toMatch(/backend|:4000|\/v1\/|createBrowserSupabaseClient|\.from\(/)
  })

  it("the loader is server-only, caches nothing and reads no Supabase table", () => {
    const loader = read("lib/parent/consent/backend-consent.ts")
    expect(loader).toMatch(/^import "server-only";/m)
    expect(code("lib/parent/consent/backend-consent.ts")).not.toMatch(/\.from\(|\.rpc\(|\bcache\(|unstable_cache|new Map\(/)
  })

  it("an outage is never read as 'not consented' by the gates", () => {
    const page = code("app/(auth)/complete-request/page.tsx")
    expect(page).toMatch(/if \(consent\.ok\) \{\s*if \(consent\.status !== "granted"\) redirect\("\/parent-consent"\)/)
    expect(page).toMatch(/case "service_unavailable":\s*return \(/)
    const requests = code("app/api/requests/route.ts")
    expect(requests).toMatch(/if \(!consent\.ok\) return authFailure\(consent\.reason\)/)
    expect(requests).toMatch(/code: "request_unavailable"/)
  })
})

describe("the consent write: CSRF -> session -> v3 -> parent-only backend route", () => {
  const route = code("app/api/parent-consent/route.ts")
  const post = route.slice(route.indexOf("async function handlePost("), route.indexOf("async function handleGet("))

  it("the Next POST runs the shared CSRF guard FIRST, then verifies the session", () => {
    const csrf = post.indexOf("rejectUnsafeBrowserWrite(request)")
    const session = post.indexOf("verifyParentCaller()")
    const body = post.indexOf("request.text()")
    expect(csrf).toBeGreaterThan(0)
    expect(session).toBeGreaterThan(csrf)
    expect(body).toBeGreaterThan(session)
    expect(route).toMatch(/import \{ rejectUnsafeBrowserWrite \} from "@\/lib\/security\/csrf"/)
  })

  it("the GET is not CSRF-guarded and writes nothing", () => {
    const get = route.slice(route.indexOf("async function handleGet("))
    expect(get).not.toMatch(/rejectUnsafeBrowserWrite|grantParentConsent/)
  })

  it("no browser-supplied identity is trusted: only the consentGranted key, no headers or cookies read", () => {
    expect(route).toMatch(/const SUPPORTED_FIELDS = new Set\(\["consentGranted"\]\)/)
    expect(post).not.toMatch(/request\.headers\.get\("(x-user-id|x-role|cookie)"\)|userId|parentProfileId|cookies\(/i)
    const loader = code("lib/parent/consent/backend-consent.ts")
    expect(loader).toMatch(/body: \{ consentGranted: true \}/)
  })

  it("the write uses backendWriteJson (v3: body digest + nonce), POST, a constant path; reads use backendGetJson (v2)", () => {
    const loader = code("lib/parent/consent/backend-consent.ts")
    const write = loader.slice(loader.indexOf("export async function grantParentConsent("))
    expect(write).toMatch(/backendWriteJson\(\{\s*operation: "parent_consent_grant",\s*method: "POST",\s*path: "\/v1\/parent\/consent"/)
    const readFn = loader.slice(loader.indexOf("export async function fetchParentConsent("), loader.indexOf("export async function loadParentConsent("))
    expect(readFn).toMatch(/backendGetJson\(\{\s*operation: "parent_consent",\s*path: "\/v1\/parent\/consent"/)
    expect(readFn).not.toMatch(/backendWriteJson/)
  })

  it("an uncertain write is never re-sent: one backendWriteJson call site, recovery is a READ", () => {
    const loader = code("lib/parent/consent/backend-consent.ts")
    expect(loader.match(/backendWriteJson\(/g)).toHaveLength(1)
    const recover = loader.slice(loader.indexOf("async function confirmAfterUncertainWrite("))
    expect(recover).toMatch(/fetchParentConsent\(context\)/)
    expect(recover).not.toMatch(/backendWriteJson|grantParentConsent/)
  })

  it("Fastify: GET requires a v2 read + parent; POST requires a v3 write + parent; caller from the principal only", () => {
    const backend = code("backend/src/routes/parent-consent.ts")
    expect(backend).toMatch(/app\.get\(CONSENT_PATH, \{ preHandler: \[requireAuth\(deps\), requireRole\("parent"\)\] \}/)
    expect(backend).toMatch(/app\.post\(CONSENT_PATH, \{ preHandler: \[requireWriteAuth\(deps, "parent"\)\] \}/)
    expect(backend).toMatch(/export const CONSENT_PATH = "\/v1\/parent\/consent"/)
    expect(backend.match(/request\.authPrincipal!\.userId/g)).toHaveLength(2)
    expect(backend).not.toMatch(/request\.(headers|cookies|params)|x-user-id|x-role|parentProfileId|body\.userId/i)
    expect(backend).toMatch(/if \(keys\.length !== 1 \|\| keys\[0\] !== "consentGranted"\) return invalid\("keys"\)/)
    expect(backend).toMatch(/consentGranted !== true\) return invalid\("value"\)/)
    expect(backend.match(/reply\.header\("Cache-Control", "no-store"\)/g)).toHaveLength(2)
  })

  it("the CSRF helper is browser-facing only: not used by the backend, nor by internal server-to-server code", () => {
    for (const f of backendRuntime) expect(code(f), f).not.toMatch(/security\/csrf/)
    for (const f of walk("lib/backend")) expect(code(f), f).not.toMatch(/security\/csrf/)
    const users = nextRuntime.filter((f) => /@\/lib\/security\/csrf/.test(code(f)))
    // V0.1.49: the account bootstrap, and the three legacy writes moved off their ad-hoc Origin checks.
    expect(users.sort()).toEqual([
      "app/api/admin/referrals/settings/route.ts",
      "app/api/parent-consent/route.ts",
      "app/api/parent/account-setup/route.ts",
      "app/api/parent/password/route.ts",
      "app/api/referrals/bind/route.ts",
      "app/api/requests/route.ts", // V0.1.50: the multipart variant of the same guard
      // V0.1.51: purchase, coupon, coupon-validation, pay and admin coupon writes.
      "app/api/admin/coupons/[id]/route.ts",
      "app/api/admin/coupons/route.ts",
      "app/api/candy-purchases/[id]/coupon/route.ts",
      "app/api/candy-purchases/[id]/pay/route.ts",
      "app/api/candy-purchases/route.ts",
      "app/api/coupons/validate/route.ts",
      // the payment return route reads only the configured origin (no guard: it is not a browser write)
      "app/api/payments/return/[provider]/route.ts",
    ].sort())
  })

  it("the CSRF origin comes from configuration, never from Host or forwarded headers", () => {
    const csrf = code("lib/security/csrf.ts")
    expect(csrf).toMatch(/env\.CARTOONA_APP_ORIGIN/)
    expect(csrf).not.toMatch(/headers\.get\("(host|x-forwarded-host|x-forwarded-proto|forwarded|referer)"\)/i)
    expect(csrf).not.toMatch(/NEXT_PUBLIC_/)
  })
})

describe("scope: only consent moved", () => {
  it("request creation is PostgreSQL (V0.1.50) through the backend; Storage is still Supabase", () => {
    const requests = code("app/api/requests/route.ts")
    expect(requests).toMatch(/createRequestViaBackend\(context, payload\)/)
    expect(requests).toMatch(/storage\.from\("parent-uploads"\)/)
    expect(requests).not.toMatch(/\.rpc\(|create_parent_request_trusted|createAdminSupabaseClient/)
  })

  it("the backend writes are proof + consent + provisioning + requests + (V0.1.51) purchases/coupons/payments, and no media or Storage code", () => {
    const writes = backendRuntime.flatMap((f) => [...code(f).matchAll(/app\.(post|put|patch|delete)\(\s*([A-Z_]+|"[^"]+")/g)].map((m) => `${m[1]} ${m[2]}`))
    expect(writes.sort()).toEqual([
      'patch "/v1/admin/coupons/:couponId"', "patch PROFILE_PATH", 'post "/v1/admin/coupons"', 'post "/v1/parent/candy-purchases"',
      'post "/v1/parent/candy-purchases/:purchaseId/coupon"', 'post "/v1/parent/candy-purchases/:purchaseId/payment-attempts"',
      'post "/v1/parent/candy-purchases/:purchaseId/payment-attempts/:attemptId/session"', "post CONSENT_PATH", "post PAYMENT_EVENTS_PATH",
      "post PROVISION_PATH", "post REQUESTS_PATH",
    ].sort())
    for (const f of backendRuntime) {
      expect(code(f), f).not.toMatch(/record_final_media|media_assets|storage\.|\.rpc\(/i)
    }
  })

  it("the only new database privilege is EXECUTE on the consent function", () => {
    const sql = sqlCode("database/migrations/0014_parent_consent_write.sql")
    expect([...sql.matchAll(/^\s*GRANT\s+([^;]+);/gim)].map((m) => m[1].replace(/\s+/g, " "))).toEqual([
      "EXECUTE ON FUNCTION public.record_parent_consent_trusted(uuid) TO cartoona_app",
    ])
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.record_parent_consent_trusted\(uuid\) FROM PUBLIC;/)
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/)
    expect(sql).not.toMatch(/\bINSERT\b|\bDELETE\b/i)
    // One-way: the only assignment is to true.
    expect(sql).toMatch(/SET consent_granted = true,\s+consent_granted_at = pg_catalog\.now\(\)/)
    expect(sql).not.toMatch(/consent_granted\s*=\s*false\s*,|consent_granted\s*=\s*p_/i)
    expect(sql).toMatch(/AND pp\.consent_granted = false;/)
  })

  it("the Supabase RPC migration removes ONLY the consent clause from create_parent_request_trusted", () => {
    const fnOf = (file: string) => {
      const s = read(file)
      const start = s.indexOf("CREATE OR REPLACE FUNCTION public.create_parent_request_trusted(")
      return s.slice(start, s.indexOf("$$;", start) + 3)
    }
    // Comment lines and blank lines dropped; everything else must be identical.
    const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(--.*)?$/.test(l)).join("\n")
    const before = fnOf("supabase/migrations/20260926100000_welcome_image_credits.sql")
    const after = fnOf("supabase/migrations/20261022100000_request_rpc_consent_gate_moved.sql")
    const consentClause = /\s*IF NOT EXISTS \(SELECT 1 FROM public\.parent_profiles pp WHERE pp\.id = v_parent_id AND pp\.consent_granted = TRUE\) THEN\s*RAISE EXCEPTION 'request_consent_required'\s*USING HINT = 'Parent consent must be granted\.';\s*END IF;/
    expect(before).toMatch(consentClause)
    expect(strip(after)).not.toMatch(/consent_granted|request_consent_required/)
    expect(strip(after)).toBe(strip(before).replace(consentClause, ""))
    // No grant/ownership/drop change: CREATE OR REPLACE keeps the service_role-only ACL.
    const migration = sqlCode("supabase/migrations/20261022100000_request_rpc_consent_gate_moved.sql")
    expect(migration).not.toMatch(/\bGRANT\b|\bREVOKE\b|DROP FUNCTION|OWNER TO/i)
    // The newest Supabase migration.
    const all = fs.readdirSync(path.join(root, "supabase/migrations")).sort()
    expect(all.at(-1)).toBe("20261022100000_request_rpc_consent_gate_moved.sql")
  })

  it("the plain-PostgreSQL request function keeps its consent check (there consent_granted IS authoritative)", () => {
    expect(sqlCode("database/migrations/0005_business_functions.sql")).toMatch(/pp\.consent_granted = TRUE\) THEN\s*RAISE EXCEPTION 'request_consent_required'/)
  })
})

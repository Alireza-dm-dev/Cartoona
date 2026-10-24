import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * V0.1.49 static guards: identity provisioning goes through ONE trusted
 * PostgreSQL function with no browser-chosen input, Supabase Auth stays the
 * identity provider (passwords included), the three legacy browser writes use
 * the shared CSRF guard, and no financial, request or media write moved.
 * Behaviour on real PostgreSQL: provisioning-db.test.ts.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const sqlCode = (p: string) => read(p).replace(/--.*$/gm, "")

function walk(dir: string, pattern = /\.(ts|tsx|js|jsx|mjs)$/): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      out.push(...walk(rel, pattern))
    } else if (pattern.test(entry.name)) out.push(rel)
  }
  return out
}

const frontendFiles = [...walk("app"), ...walk("components"), ...walk("lib"), "middleware.ts"].filter((f) => !f.startsWith("lib/repositories/") && !f.startsWith("lib/db/"))
const backendRuntime = walk("backend/src")
const MIGRATION = "database/migrations/0015_supabase_parent_provisioning.sql"

describe("provisioning uses the trusted PostgreSQL function, and only it", () => {
  it("the function takes ONE argument (the subject), fixes the role, and is EXECUTE-only for cartoona_app", () => {
    const sql = sqlCode(MIGRATION)
    expect(sql).toMatch(/CREATE FUNCTION public\.provision_supabase_parent_identity\(p_subject uuid\)\s+RETURNS text/)
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/)
    expect(sql).toMatch(/INSERT INTO public\.users \(id, email, role\) VALUES \(p_subject, NULL, 'parent'\)/)
    expect([...sql.matchAll(/^\s*GRANT\s+([^;]+);/gim)].map((m) => m[1].replace(/\s+/g, " "))).toEqual([
      "EXECUTE ON FUNCTION public.provision_supabase_parent_identity(uuid) TO cartoona_app",
    ])
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.provision_supabase_parent_identity\(uuid\) FROM PUBLIC;/)
  })

  it("never generates a user id: users.id = subject; the identity id is the copy tool's deterministic one", () => {
    const sql = sqlCode(MIGRATION)
    expect(sql).not.toMatch(/gen_random_uuid/)
    expect(sql.match(/md5\('cartoona-identity:supabase:' \|\| v_subject\)::uuid/g)).toHaveLength(2)
    expect(read("scripts/db/data-copy/mapping.ts")).toMatch(/md5\('cartoona-identity:supabase:' \|\| user id\)::uuid/)
  })

  it("serialized per subject and checked before any write (no duplicate profile, wallet or welcome grant)", () => {
    const sql = sqlCode(MIGRATION)
    const lock = sql.indexOf("pg_advisory_xact_lock(")
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(sql.indexOf("INSERT INTO"))
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.parent_profiles pp WHERE pp\.user_id = p_subject\) THEN\s+INSERT INTO public\.parent_profiles \(user_id\) VALUES \(p_subject\);/)
    // Wallet, welcome credits and referral code come ONLY from the existing profile triggers.
    expect(sql).not.toMatch(/INSERT INTO public\.(candy_wallets|parent_welcome_credits|candy_transactions)/)
    expect(sql).not.toMatch(/referral_code\s*[:=,)]/)
  })

  it("the repository is the only caller, and only the provisioning route uses it", () => {
    const repo = code("lib/repositories/user-provisioning.ts")
    expect(repo).toMatch(/SELECT public\.provision_supabase_parent_identity\(\$1::uuid\) AS outcome/)
    expect(repo).toMatch(/isValidSubject\("supabase", input\.providerSubject\)/)
    const users = [...backendRuntime, ...frontendFiles].filter((f) => /repositories\/user-provisioning/.test(code(f)))
    expect(users).toEqual(["backend/src/routes/auth-provision.ts"])
    const callers = [...walk("lib"), ...backendRuntime].filter((f) => f !== "lib/repositories/user-provisioning.ts" && /provision_supabase_parent_identity/.test(code(f)))
    expect(callers).toEqual([])
  })

  it("no runtime code inserts users, identities or profiles any other way", () => {
    for (const f of [...walk("lib/repositories"), ...backendRuntime]) {
      expect(code(f), f).not.toMatch(/INSERT\s+INTO\s+public\.(users|user_identities|parent_profiles|candy_wallets|parent_welcome_credits)\b/i)
    }
  })
})

describe("the browser cannot choose the role, user id, profile id or subject", () => {
  it("the backend route takes the subject from requireProvisioningAuth only and requires the body {}", () => {
    const route = code("backend/src/routes/auth-provision.ts")
    expect(route).toMatch(/preHandler: \[requireProvisioningAuth\(deps\)\]/)
    expect(route).toMatch(/provisionSupabaseParent\(deps\.db\(\), \{ providerSubject: request\.provisioningSubject! \}\)/)
    expect(route).toMatch(/Object\.keys\(body\)\.length !== 0/)
    expect(route).not.toMatch(/request\.(headers|query)\[|request\.body\.\w+|params\./)
    expect(route).toMatch(/return \{ provisioned: true \}/)
    const plugin = code("backend/src/plugins/auth.ts")
    expect(plugin).toMatch(/request\.provisioningSubject = claims\.subject/)
    expect(plugin.match(/provisioningSubject =/g)).toHaveLength(1)
  })

  it("the Next caller always sends the literal body {}; the BFF refuses any field (422)", () => {
    expect(code("lib/parent/account-setup/backend-provision.ts")).toMatch(/path: "\/v1\/auth\/provision",\s+body: \{\},/)
    const bff = code("app/api/parent/account-setup/route.ts")
    expect(bff).toMatch(/if \(Object\.keys\(body\)\.length > 0\) return json\(\{ error: "Unsupported fields" \}, 422\)/)
    expect(bff.indexOf("rejectUnsafeBrowserWrite(request)")).toBeLessThan(bff.indexOf("verifyParentCaller()"))
    expect(bff).not.toMatch(/userId|parentProfileId|\brole\b/)
    expect(code("lib/parent/account-setup/account-setup-client.ts")).toMatch(/body: "\{\}"/)
  })

  it("no GET route or page provisions: only the POST bootstrap calls the backend provisioning", () => {
    const users = frontendFiles.filter((f) => /account-setup\/backend-provision|provisionParentAccount/.test(code(f)) && f !== "lib/parent/account-setup/backend-provision.ts")
    expect(users).toEqual(["app/api/parent/account-setup/route.ts"])
    expect(code("app/api/parent/account-setup/route.ts")).not.toMatch(/export const GET/)
  })

  it("the frontend never touches the database directly", () => {
    for (const f of [...walk("app"), ...walk("components"), ...walk("lib/parent"), "middleware.ts"]) {
      expect(code(f), f).not.toMatch(/from "pg"|@\/lib\/db\/|@\/lib\/repositories\//)
    }
  })
})

describe("Supabase Auth remains the identity provider", () => {
  it("the only identity provider is supabase; signup/login still authenticate with Supabase", () => {
    expect(code("lib/identity/types.ts")).toMatch(/export const IDENTITY_PROVIDERS = \["supabase"\] as const/)
    expect(code("app/(auth)/signup/page.tsx")).toMatch(/supabase\.auth\.signInWithOtp\(/)
    expect(code("app/(auth)/signup/page.tsx")).toMatch(/supabase\.auth\.verifyOtp\(/)
    expect(code("app/(auth)/login/page.tsx")).toMatch(/supabase\.auth\.signInWithPassword\(/)
    // The Supabase-side profile step of signup is unchanged (request/purchase writes still need it).
    expect(code("app/api/parent/complete-signup/route.ts")).toMatch(/ensureParentProfile\(supabase,/)
  })

  it("every successful sign-in and signup runs the bootstrap before continuing", () => {
    const login = code("app/(auth)/login/page.tsx")
    expect(login.match(/await continueAfterSignIn\(/g)).toHaveLength(4)
    expect(login).not.toMatch(/window\.location\.assign\(resolveDevDestination|window\.location\.assign\(destination\)/)
    const signup = code("app/(auth)/signup/page.tsx")
    expect(signup.match(/await continueAfterSignup\(\)/g)).toHaveLength(2)
    expect(signup.match(/window\.location\.assign\("\/parent-consent"\)/g)).toHaveLength(2) // ready, and the retry card's onReady
  })

  it("a bootstrap failure never signs the user out (only an expired/invalidated session does)", () => {
    const bff = code("app/api/parent/account-setup/route.ts")
    const outages = bff.slice(bff.indexOf('case "service_unavailable":'))
    expect(outages).toMatch(/account_setup_incomplete/)
    expect(outages).not.toMatch(/endParentSession/)
    expect(read("lib/parent/account-setup/messages.ts")).toContain("ورود انجام شد، اما آماده‌سازی حساب کامل نشد. لطفاً دوباره تلاش کنید.")
  })
})

describe("password: Supabase Auth only", () => {
  const route = code("app/api/parent/password/route.ts")

  it("the password is changed by supabase.auth.updateUser and nothing else", () => {
    expect(route).toMatch(/supabase\.auth\.updateUser\(\{\s+password,/)
    expect(route).not.toMatch(/@\/lib\/backend|backend-caller|@\/lib\/db|repositories|fetch\(/)
  })

  it("no password material reaches Fastify, PostgreSQL or a log", () => {
    for (const f of [...backendRuntime, ...walk("lib/repositories")]) {
      expect(code(f), f).not.toMatch(/confirmPassword|updateUser\(|password_set|["']password["']/)
    }
    // No column can hold a credential (0003's table comment says so in words).
    for (const f of walk("database/migrations", /\.sql$/)) expect(sqlCode(f), f).not.toMatch(/\b\w*password\w*\s+(text|character|varchar|bytea)\b/i)
    expect(route).not.toMatch(/\blog(Event)?\(|console\./)
    const logger = code("lib/observability/logger.ts")
    expect(logger.slice(logger.indexOf("const VALIDATORS"), logger.indexOf("const FIELD_ORDER"))).not.toMatch(/password/i)
  })
})

describe("legacy browser writes use the shared CSRF guard (V0.1.49)", () => {
  const LEGACY = ["app/api/parent/password/route.ts", "app/api/referrals/bind/route.ts", "app/api/admin/referrals/settings/route.ts"]

  it.each(LEGACY)("%s: rejectUnsafeBrowserWrite first, no ad-hoc Origin logic left", (f) => {
    const src = code(f)
    expect(src).toMatch(/const rejected = rejectUnsafeBrowserWrite\(request\)\s+if \(rejected\) return rejected/)
    expect(src.indexOf("rejectUnsafeBrowserWrite(request)")).toBeLessThan(src.indexOf("createServerSupabaseClient()"))
    expect(src).not.toMatch(/validateOrigin|isLocalhostOrigin|getAllowedOrigins|NEXT_PUBLIC_SITE_URL|headers\.get\("origin"\)/)
  })

  it("no route under app/api reads Origin by hand any more", () => {
    for (const f of walk("app/api")) expect(code(f), f).not.toMatch(/headers\.get\(["']origin["']\)/i)
  })

  it("referral writes stay on Supabase (their business logic did not move)", () => {
    expect(code("app/api/referrals/bind/route.ts")).toMatch(/\.rpc\("bind_current_parent_referral_code"/)
    for (const f of LEGACY) expect(code(f), f).not.toMatch(/@\/lib\/backend|backend-caller/)
  })
})

describe("scope: no financial, request or media write migrated", () => {
  it("migration 0015 touches identity/profile defaults only", () => {
    expect(sqlCode(MIGRATION)).not.toMatch(/candy_purchases|payment_attempts|coupon|orders|media_assets|candy_transactions|create_parent_request/i)
  })

  it("request creation, candy purchases, coupons and media still go to Supabase", () => {
    expect(code("app/api/requests/route.ts")).toMatch(/create_parent_request_trusted/)
    expect(code("app/api/candy-purchases/route.ts")).toMatch(/createServerSupabaseClient|createAdminSupabaseClient/)
    for (const f of ["app/api/candy-purchases/route.ts", ...walk("app/api/coupons"), ...walk("app/api/admin/requests")]) {
      expect(code(f), f).not.toMatch(/@\/lib\/backend|backend-caller/)
    }
  })
})

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { composeService, withoutYamlComments } from "../helpers/compose-text"

/**
 * Static guards for the V0.1.42 identity boundary: which module may know about
 * which provider, where secrets may go, and which identity inputs the backend
 * may read at all.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*#.*$/gm, "")
const imports = (p: string) => [...code(p).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])

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

const compose = withoutYamlComments(read("compose.yml"))
const frontend = composeService(compose, "frontend")
const backend = composeService(compose, "backend")

describe("neutral identity modules", () => {
  it.each(walk("lib/identity"))("%s imports no Next.js, Fastify, Supabase or database code", (file) => {
    for (const spec of imports(file)) {
      expect(spec).toMatch(/^(node:crypto|\.\/|@\/lib\/observability\/request-id)/)
    }
  })

  it("the assertion carries no PII/token fields by construction", () => {
    const src = code("lib/identity/assertion.ts")
    // v2 (reads) and v3 (writes, V0.1.47: + nonce and body digest), nothing else.
    expect(src).toMatch(/2: \["aat", "exp", "iat", "mth", "prv", "pth", "rid", "sub", "v"\],/)
    expect(src).toMatch(/3: \["aat", "bdg", "exp", "iat", "mth", "nce", "prv", "pth", "rid", "sub", "v"\],/)
    expect(src).not.toMatch(/email|phone|access_token|refresh_token|role:/i)
  })
})

describe("the Supabase adapter verifies identity and nothing else", () => {
  const adapter = "lib/auth/supabase-identity-adapter.ts"

  it("is server-only", () => {
    expect(read(adapter)).toMatch(/^import "server-only"/m)
  })

  it("reads no database, table, RPC, role or profile, and never auth.sessions", () => {
    const src = code(adapter)
    expect(src).not.toMatch(/\.from\(|\.rpc\(|@\/lib\/(db|repositories)|from "pg"|parent_profiles|auth\.sessions/)
    expect(imports(adapter).sort()).toEqual([
      "./auth-deadline", "./supabase-session-evidence", "@/lib/identity/session-policy", "@/lib/identity/types",
      "@/lib/supabase/server", "@supabase/supabase-js",
    ].sort())
  })

  it("verifies EXACTLY the token whose claims it reads, then returns only identity + sign-in time", () => {
    const src = code(adapter)
    // getUser is called with the session's access token, and evidence is read from that same variable.
    expect(src).toMatch(/const accessToken = sessionData\?\.session\?\.access_token/)
    expect(src).toMatch(/supabase\.auth\.getUser\(accessToken\)/)
    expect(src).toMatch(/readSupabaseSessionEvidence\(accessToken\)/)
    expect(src.indexOf("getUser(accessToken)")).toBeLessThan(src.indexOf("readSupabaseSessionEvidence(accessToken)"))
    expect(src).toMatch(/evidence\.subject !== data\.user\.id/)
    // The context holds two fields; no token, claim set or refresh token is returned.
    expect(src).toMatch(/context: \{\s*identity: toVerifiedIdentity\(\{ provider: "supabase", subject: data\.user\.id \}\),\s*authenticatedAt: evidence\.authenticatedAt,\s*\}/)
    expect(src).not.toMatch(/refresh_token|claims:|accessToken,\s*\}/)
  })

  it("never derives the session start from the token issue time", () => {
    for (const file of ["lib/auth/supabase-session-evidence.ts", "lib/auth/supabase-identity-adapter.ts", "lib/auth/parent-session-lifetime.ts"]) {
      expect(code(file), file).not.toMatch(/\biat\b/)
    }
    expect(code("lib/auth/supabase-session-evidence.ts")).toMatch(/earliest = Math\.min\(earliest, timestamp\)/)
  })
})

describe("the backend trusts only the signed internal assertion", () => {
  const backendSrc = walk("backend/src")

  it.each(backendSrc)("%s has no Supabase dependency", (file) => {
    expect(code(file)).not.toMatch(/supabase-js|@supabase\/|SUPABASE_|createServerClient/)
  })

  it("no backend code reads browser identity headers, cookies or bearer tokens", () => {
    for (const file of backendSrc) {
      expect(code(file), file).not.toMatch(/x-user-id|x-role|["']authorization["']|headers\.cookie|\.cookies\b|bearer/i)
    }
  })

  it("the auth plugin reads exactly one header", () => {
    const src = code("backend/src/plugins/auth.ts")
    expect([...src.matchAll(/request\.headers\[([^\]]+)\]/g)].map((m) => m[1])).toEqual(["HEADER"])
    expect(src).toMatch(/const HEADER = "x-cartoona-internal-auth"/)
  })

  it("identity resolution is read-only and parameterised", () => {
    const repo = code("lib/repositories/user-identities.ts")
    expect(repo).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT)\b/i)
    expect(repo).toMatch(/WHERE ui\.provider = \$1\s+AND ui\.provider_subject = \$2/)
    expect(repo).not.toContain("${")
  })

  it("nothing on the new path depends on auth.uid(), auth.jwt() or auth.sessions", () => {
    for (const file of [...backendSrc, ...walk("lib/identity"), ...walk("lib/repositories"), "lib/auth/supabase-identity-adapter.ts", "app/api/auth/backend-me/route.ts"]) {
      expect(code(file), file).not.toMatch(/auth\.(uid|jwt|sessions)\b/)
    }
  })
})

describe("secrets: one shared internal-auth secret, nothing else crosses", () => {
  it("frontend and backend both receive CARTOONA_INTERNAL_AUTH_SECRET from the environment", () => {
    for (const service of [frontend, backend]) {
      expect(service).toMatch(/^\s+CARTOONA_INTERNAL_AUTH_SECRET: \$\{CARTOONA_INTERNAL_AUTH_SECRET:-\}\s*$/m)
    }
  })

  it("the backend receives no Supabase variable and no env_file", () => {
    expect(backend).not.toMatch(/SUPABASE|env_file/)
  })

  it("the frontend still receives no database credential", () => {
    for (const name of ["POSTGRES_PASSWORD", "DATABASE_URL", "BACKEND_DATABASE_URL", "CARTOONA_APP_DB_PASSWORD"]) {
      expect(frontend).toMatch(new RegExp(`^\\s+${name}:\\s*""\\s*$`, "m"))
    }
  })

  it("the secret is never NEXT_PUBLIC_*, never a build arg, never in the frontend Dockerfile", () => {
    for (const file of [...walk("app"), ...walk("components"), ...walk("lib"), "compose.yml", "Dockerfile", "backend/Dockerfile", "next.config.ts", ".env.example", ".env.local.example", ".env.docker.example"]) {
      expect(read(file), file).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(AUTH_SECRET|INTERNAL)/)
    }
    expect(read("Dockerfile")).not.toMatch(/CARTOONA_INTERNAL_AUTH_SECRET/)
    expect(read("backend/Dockerfile")).not.toMatch(/CARTOONA_INTERNAL_AUTH_SECRET/)
    expect(frontend.split("args:")[1]?.split("image:")[0] ?? "").not.toMatch(/AUTH_SECRET/)
  })

  it("only lib/identity reads the secret from the environment", () => {
    const readers = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("backend/src"), "middleware.ts"]
      .filter((f) => /process\.env\.CARTOONA_INTERNAL_AUTH_SECRET|env\.CARTOONA_INTERNAL_AUTH_SECRET/.test(code(f)))
    expect(readers).toEqual(["lib/identity/assertion.ts"])
  })

  it("templates carry placeholders only", () => {
    expect(/^CARTOONA_INTERNAL_AUTH_SECRET=(.*)$/m.exec(read(".env.docker.example"))?.[1]).toBe("your-internal-auth-secret-64-hex-chars")
    for (const file of [".env.example", ".env.local.example"]) {
      expect(/^CARTOONA_INTERNAL_AUTH_SECRET=(.*)$/m.exec(read(file))?.[1], file).toBe("")
    }
  })
})

describe("nothing identity-related reaches a browser bundle", () => {
  it("no Client Component imports the adapter, the assertion or the backend client", () => {
    const clients = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => /^["']use client["']/m.test(read(f)))
    expect(clients.length).toBeGreaterThan(10)
    for (const file of clients) {
      expect(read(file), file).not.toMatch(/@\/lib\/(identity|backend)\/|supabase-identity-adapter|auth-deadline/)
    }
  })

  it("the proof route never returns the assertion or provider subject", () => {
    const route = code("app/api/auth/backend-me/route.ts")
    expect(route).toMatch(/json\(\{ authenticated: true, userId: result\.userId, role: result\.role \}, 200\)/)
    expect(route).not.toMatch(/subject|INTERNAL_AUTH_HEADER|signAssertion/)
  })
})

describe("V0.1.43: no runtime dependency on Supabase session internals", () => {
  const runtime = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("backend/src"), "middleware.ts"]

  it.each(runtime)("%s does not reference auth.sessions, auth.jwt(), the old lifetime check or its RPC", (file) => {
    expect(code(file)).not.toMatch(/auth\.sessions|auth\.jwt\s*\(|checkCurrentParentSessionLifetime|get_current_parent_session_policy/)
  })

  it("the plain PostgreSQL migrations do not either", () => {
    for (const file of fs.readdirSync(path.join(root, "database/migrations"))) {
      expect(read(`database/migrations/${file}`).replace(/--.*$/gm, ""), file).not.toMatch(/auth\.sessions|auth\.jwt|get_current_parent_session_policy/)
    }
  })

  it("historical references remain only in the untouched Supabase migrations (and are not rewritten)", () => {
    const historical = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => /auth\.sessions/.test(read(`supabase/migrations/${f}`)))
    expect(historical).toContain("20260725120000_parent_session_lifetime.sql")
  })

  it("every former caller uses the provider-neutral lifetime check with the VERIFIED user id", () => {
    const callers = runtime.filter((f) => /checkParentSessionLifetime\(/.test(code(f)) && f !== "lib/auth/parent-session-lifetime.ts")
    // 13 since V0.1.48: POST /api/parent-consent verifies through
    // verifyParentCaller (same 30-day policy) and the backend (which also
    // enforces sessions_not_before), like the other cut-over routes.
    expect(callers.length).toBe(13)
    for (const file of callers) {
      expect(code(file), file).toMatch(/checkParentSessionLifetime\(supabase, (user\.id|ownership\.userId)\)/)
    }
  })

  it("the session policy is pure and neutral", () => {
    expect(imports("lib/identity/session-policy.ts")).toEqual([])
    expect(code("lib/auth/supabase-session-evidence.ts")).not.toMatch(/^import /m)
  })

  it("the backend evaluates the policy inside requireAuth, from the signed sign-in time and the resolved cut-off", () => {
    const src = code("backend/src/plugins/auth.ts")
    expect(src).toMatch(/evaluateSessionPolicy\(\s*\{ authenticatedAt: result\.claims\.authenticatedAt \},\s*\{ \.\.\.DEFAULT_SESSION_POLICY, sessionsNotBefore: identity\.sessionsNotBefore \}/)
    // Shared by reads and writes (V0.1.47); the principal is only returned after it.
    expect(src.indexOf("evaluateSessionPolicy(")).toBeLessThan(src.indexOf("return { claims: result.claims, principal:"))
    expect(src.match(/evaluateSessionPolicy\(/g)).toHaveLength(1)
  })

  it("migration 0011 adds the nullable column and grants nothing", () => {
    const sql = read("database/migrations/0011_users_sessions_not_before.sql").replace(/--.*$/gm, "")
    expect(sql).toMatch(/ALTER TABLE public\.users ADD COLUMN sessions_not_before timestamp with time zone;/)
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|GRANT|UPDATE /i)
  })
})

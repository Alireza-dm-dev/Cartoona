/**
 * Pure production configuration checks (V0.1.55). No I/O, no network, no
 * mutation; `env` is a plain object. Every `detail` is a fixed sentence that
 * names a variable, never its value, so a report is safe to paste into a ticket.
 *
 * service: "frontend" (Next) or "backend" (Fastify). The two never share an
 * environment, so there is deliberately no "all".
 */

const HEX = /^[0-9a-fA-F]+$/
const PLACEHOLDER = /your-|changeme|change-me|example|placeholder|<.*>|xxxx/i

/** Variables that must be absent from a production process, and why. */
const FORBIDDEN_EVERYWHERE = [
  ["DEV_PARENT_AUTH_ENABLED", "development parent sign-in switch"],
  ["DEV_PARENT_AUTH_SECRET", "development parent sign-in secret"],
  ["DEV_TEST_PARENT_PASSWORD", "development test password"],
  ["RATE_LIMIT_DISABLED", "rate limiting must not be disabled"],
  ["CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "destructive test switch"],
]
const FORBIDDEN_FRONTEND = [
  ["DATABASE_URL", "the frontend never holds a database credential"],
  ["CARTOONA_APP_DB_PASSWORD", "database credential"],
]
const FORBIDDEN_BACKEND = [
  ["SUPABASE_SECRET_KEY", "the backend never touches Storage"],
  ["BACKEND_INTERNAL_URL", "the backend does not call itself"],
]

const set = (env, name) => (env[name] ?? "").trim() !== ""
const setWithPrefix = (env, prefix) => Object.keys(env).filter((k) => k.startsWith(prefix) && set(env, k))

function secretProblem(value) {
  if (PLACEHOLDER.test(value)) return "looks like a placeholder"
  if (!HEX.test(value) || value.length % 2 !== 0) return "must be hex (openssl rand -hex 32)"
  if (value.length < 64) return "must be at least 32 bytes (64 hex characters)"
  if (new Set(value.toLowerCase()).size < 8) return "has too little variety to be random"
  return null
}

function originProblem(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:") return "must be https"
    if (/^(localhost|127\.|\[?::1)/.test(url.hostname)) return "must not be a loopback address"
    if (url.origin !== value) return "must be an exact origin (scheme://host[:port], no trailing slash or path)"
    return null
  } catch {
    return "is not a valid URL"
  }
}

export function runPreflight(env, { service, payments = false, expectFreeze = null, allowPlaintextPrivateDb = false }) {
  const checks = []
  const add = (id, status, detail) => checks.push({ id, status, detail })
  const pass = (id, detail) => add(id, "pass", detail)
  const fail = (id, detail) => add(id, "fail", detail)
  const warn = (id, detail) => add(id, "warn", detail)
  if (service !== "frontend" && service !== "backend") throw new Error("service must be frontend or backend")
  const frontend = service === "frontend"
  const backend = service === "backend"

  if (env.NODE_ENV === "production") pass("node_env", "NODE_ENV is production")
  else fail("node_env", "NODE_ENV must be production")

  // The shared secret: both services hold the same value.
  if (!set(env, "CARTOONA_INTERNAL_AUTH_SECRET")) fail("internal_auth_secret", "CARTOONA_INTERNAL_AUTH_SECRET is not set")
  else {
    const problem = secretProblem(env.CARTOONA_INTERNAL_AUTH_SECRET.trim())
    if (problem) fail("internal_auth_secret", `CARTOONA_INTERNAL_AUTH_SECRET ${problem}`)
    else pass("internal_auth_secret", "CARTOONA_INTERNAL_AUTH_SECRET is a strong hex secret")
  }

  for (const [name, why] of FORBIDDEN_EVERYWHERE) if (set(env, name)) fail(`forbidden_${name}`, `${name} must be unset (${why})`)
  for (const name of setWithPrefix(env, "CARTOONA_TEST_")) fail(`forbidden_${name}`, `${name} is a test variable and must be unset`)
  for (const name of setWithPrefix(env, "CARTOONA_PAYMENT_STUB_")) fail(`forbidden_${name}`, `${name} configures the stub provider and must be unset`)
  if (env.CARTOONA_PAYMENT_PROVIDER?.trim() === "stub") fail("payment_stub", "CARTOONA_PAYMENT_PROVIDER must not be stub in production")

  if (frontend) {
    for (const [name, why] of FORBIDDEN_FRONTEND) if (set(env, name)) fail(`frontend_forbidden_${name}`, `${name} must be unset on the frontend (${why})`)
    for (const name of setWithPrefix(env, "POSTGRES_")) fail(`frontend_forbidden_${name}`, `${name} must be unset on the frontend`)

    const site = env.NEXT_PUBLIC_SITE_URL?.trim()
    if (!site) fail("site_url", "NEXT_PUBLIC_SITE_URL is not set")
    else if (originProblem(site)) fail("site_url", `NEXT_PUBLIC_SITE_URL ${originProblem(site)}`)
    else pass("site_url", "NEXT_PUBLIC_SITE_URL is a public https origin")

    const origins = (env.CARTOONA_APP_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    if (origins.length === 0) fail("app_origin", "CARTOONA_APP_ORIGIN is not set (production refuses every browser write)")
    else {
      const bad = origins.map(originProblem).find(Boolean)
      if (bad) fail("app_origin", `CARTOONA_APP_ORIGIN ${bad}`)
      else pass("app_origin", `CARTOONA_APP_ORIGIN lists ${origins.length} exact https origin(s)`)
    }

    const sb = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    if (!sb) fail("supabase_url", "NEXT_PUBLIC_SUPABASE_URL is not set")
    else if (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(sb)) pass("supabase_url", "NEXT_PUBLIC_SUPABASE_URL is a Supabase project URL")
    else fail("supabase_url", "NEXT_PUBLIC_SUPABASE_URL is not a https://<ref>.supabase.co project URL")
    if (set(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY")) pass("supabase_anon_key", "NEXT_PUBLIC_SUPABASE_ANON_KEY is set")
    else fail("supabase_anon_key", "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set")
    if (!set(env, "SUPABASE_SECRET_KEY")) fail("supabase_storage_key", "SUPABASE_SECRET_KEY (Storage service credential) is not set")
    else if (env.SUPABASE_SECRET_KEY.trim() === env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) fail("supabase_storage_key", "SUPABASE_SECRET_KEY equals the public key")
    else pass("supabase_storage_key", "SUPABASE_SECRET_KEY is set and differs from the public key")

    const be = env.BACKEND_INTERNAL_URL?.trim()
    if (!be) fail("backend_url", "BACKEND_INTERNAL_URL is not set")
    else {
      try {
        const url = new URL(be)
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) fail("backend_url", "BACKEND_INTERNAL_URL must be a plain http(s)://host[:port] address")
        else if (origins.includes(url.origin)) fail("backend_url", "BACKEND_INTERNAL_URL equals a public app origin (the backend must be private)")
        else pass("backend_url", "BACKEND_INTERNAL_URL is a plain address (private reachability is checked by cutover:check)")
      } catch {
        fail("backend_url", "BACKEND_INTERNAL_URL is not a valid URL")
      }
    }
    // Anything NEXT_PUBLIC_ is compiled into the browser bundle.
    for (const name of Object.keys(env)) if (name.startsWith("NEXT_PUBLIC_") && /SECRET|PASSWORD|DATABASE|SERVICE|BACKEND|INTERNAL/i.test(name)) fail(`public_${name}`, `${name} would be embedded in the browser bundle`)

    const hash = env.RATE_LIMIT_HASH_SECRET?.trim()
    if (!hash || hash.length < 32) fail("rate_limit_secret", "RATE_LIMIT_HASH_SECRET must be set (at least 32 characters)")
    else pass("rate_limit_secret", "RATE_LIMIT_HASH_SECRET is set")
    if (set(env, "RATE_LIMIT_TRUSTED_IP_HEADER")) pass("rate_limit_ip_header", "RATE_LIMIT_TRUSTED_IP_HEADER is set")
    else warn("rate_limit_ip_header", "RATE_LIMIT_TRUSTED_IP_HEADER is not set (limits key on a fallback address)")

    const provider = env.CARTOONA_PAYMENT_PROVIDER?.trim()
    if (!provider) {
      if (payments) fail("payment_provider", "payments are required but no CARTOONA_PAYMENT_PROVIDER is configured (no real provider adapter exists)")
      else warn("payment_provider", "no payment provider: purchases answer PAYMENT_UNAVAILABLE")
    } else if (provider !== "stub") fail("payment_provider", "CARTOONA_PAYMENT_PROVIDER names a provider without an adapter in this build")
  }

  if (backend) {
    for (const [name, why] of FORBIDDEN_BACKEND) if (set(env, name)) fail(`backend_forbidden_${name}`, `${name} must be unset on the backend (${why})`)
    for (const name of setWithPrefix(env, "CARTOONA_PAYMENT_")) fail(`backend_forbidden_${name}`, `${name} must be unset on the backend (provider settings stay in the frontend)`)
    for (const name of ["BACKEND_PORT", "DB_POOL_MAX", "DB_IDLE_TIMEOUT_MS", "DB_CONNECTION_TIMEOUT_MS"]) {
      if (set(env, name) && !/^\d+$/.test(env[name].trim())) fail(`backend_${name}`, `${name} must be an integer`)
    }
    if (/^\d+$/.test(env.DB_POOL_MAX?.trim() ?? "") && (Number(env.DB_POOL_MAX) < 1 || Number(env.DB_POOL_MAX) > 50)) fail("backend_DB_POOL_MAX", "DB_POOL_MAX must be between 1 and 50")

    const raw = env.DATABASE_URL?.trim()
    if (!raw) fail("database_url", "DATABASE_URL is not set")
    else {
      let url = null
      try { url = new URL(raw) } catch { fail("database_url", "DATABASE_URL is not a valid postgresql:// URL") }
      if (url) {
        const user = decodeURIComponent(url.username)
        const password = decodeURIComponent(url.password)
        const loopback = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(url.hostname)
        const problems = []
        if (!/^postgres(ql)?:$/.test(url.protocol)) problems.push("scheme is not postgresql")
        if (url.search) problems.push("query parameters are not allowed (use DB_SSL_MODE)")
        if (!url.pathname || url.pathname === "/") problems.push("no database name")
        if (/(^|\.)supabase\.(co|com|net|in)$/i.test(url.hostname)) problems.push("host is hosted Supabase")
        if (!user) problems.push("no user")
        else if (!user.startsWith("cartoona_app_")) problems.push("user is not a cartoona_app_<name> login role")
        if (!password) problems.push("no password")
        else if (PLACEHOLDER.test(password) || password.length < 24) problems.push("password is a placeholder or shorter than 24 characters")
        if (problems.length) fail("database_url", `DATABASE_URL: ${problems.join("; ")}`)
        else pass("database_url", "DATABASE_URL names a cartoona_app_* login, a database and a password")

        const ssl = env.DB_SSL_MODE?.trim() || "disable"
        if (ssl === "verify-full") pass("database_tls", "DB_SSL_MODE=verify-full")
        else if (ssl !== "disable") fail("database_tls", "DB_SSL_MODE must be disable or verify-full")
        else if (loopback) warn("database_tls", "no TLS to a loopback database (acceptable only for local runs)")
        else if (allowPlaintextPrivateDb) warn("database_tls", "plaintext PostgreSQL accepted by --allow-plaintext-private-db (private network only)")
        else fail("database_tls", "DATABASE_URL is not loopback and DB_SSL_MODE is not verify-full")
      }
    }
  }

  const freeze = env.CARTOONA_WRITE_FREEZE
  if (freeze === undefined || freeze.trim() === "") {
    if (expectFreeze === "on") fail("write_freeze", "CARTOONA_WRITE_FREEZE is not set but the freeze is expected ON")
    else pass("write_freeze", "write freeze is OFF")
  } else if (freeze === "1") {
    if (expectFreeze === "off") fail("write_freeze", "write freeze is ON but expected OFF")
    else pass("write_freeze", "write freeze is ON")
  } else fail("write_freeze", "CARTOONA_WRITE_FREEZE is set to a value other than exactly 1, which freezes nothing")

  return { ok: checks.every((c) => c.status !== "fail"), checks }
}

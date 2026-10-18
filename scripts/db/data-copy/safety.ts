/**
 * Connection-target safety for the data-copy tool (V0.1.44). Pure: no I/O.
 *
 * Both URLs are named explicitly (CARTOONA_COPY_SOURCE_URL and
 * CARTOONA_COPY_TARGET_URL). Nothing is inferred: DATABASE_URL and .env files
 * are never read. Every message written here describes a URL as
 * user@host:port/db and never contains its password.
 */

export class DataCopyError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly details: string[]
  constructor(code: string, message: string, opts: { exitCode?: number; details?: string[] } = {}) {
    super(message)
    this.name = "DataCopyError"
    this.code = code
    this.exitCode = opts.exitCode ?? 2
    this.details = opts.details ?? []
  }
}

/** Known Cartoona Supabase projects: production, migration-test, disposable. */
export const FORBIDDEN_PROJECT_REFS = ["oucyhmrnzahlhqjfqcge", "guhhlshjvmiwwmixiulk", "bkctpxclggiqfllbjbre"]
const SUPABASE_HOST = /(^|\.)supabase\.(co|com|net|in)$|(^|\.)pooler\./i
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "postgres"])
const MAINTENANCE_DBS = new Set(["postgres", "template0", "template1"])
const AMBIENT_PG_ENV = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE"]

export interface ParsedDbUrl {
  user: string
  host: string
  port: number
  database: string
  /** For display: user@host:port/db. Never contains the password. */
  label: string
}

/**
 * Parse postgres[ql]://user[:password]@host[:port]/database and nothing else:
 * no query string (it can override host/db/TLS), one host, a database name.
 */
export function parseDbUrl(raw: string | undefined, name: string, extraRefs: string[] = []): ParsedDbUrl {
  if (!raw || raw.trim() === "") throw new DataCopyError("missing_url", `${name} is not set. Name the database explicitly; nothing is inferred.`)
  const value = raw.trim()
  const lower = value.toLowerCase()
  for (const ref of [...FORBIDDEN_PROJECT_REFS, ...extraRefs]) {
    if (ref && lower.includes(ref.toLowerCase())) {
      throw new DataCopyError("unsafe_url", `${name} names a Cartoona Supabase project. This tool never connects to a hosted Supabase project.`)
    }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DataCopyError("unsafe_url", `${name} is not a valid postgresql:// URL.`)
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new DataCopyError("unsafe_url", `${name} must use the postgresql:// scheme.`)
  if (url.search || value.includes("?")) throw new DataCopyError("unsafe_url", `${name} must not carry query parameters; they can override the host or database.`)
  if (value.includes(",")) throw new DataCopyError("unsafe_url", `${name} lists several hosts. Name exactly one.`)
  if (!url.username) throw new DataCopyError("unsafe_url", `${name} must name a user.`)
  const host = url.hostname.toLowerCase()
  if (!host) throw new DataCopyError("unsafe_url", `${name} must name a host.`)
  if (SUPABASE_HOST.test(host.replace(/^\[|\]$/g, ""))) {
    throw new DataCopyError("unsafe_url", `${name} points at a hosted Supabase endpoint. This tool never connects to hosted Supabase.`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (!database || database.includes("/")) throw new DataCopyError("unsafe_url", `${name} must name exactly one database.`)
  const port = url.port ? Number(url.port) : 5432
  const user = decodeURIComponent(url.username)
  return { user, host, port, database, label: `${user}@${host}:${port}/${database}` }
}

/** Local only: loopback or the compose service name, never a maintenance database. */
function assertLocal(parsed: ParsedDbUrl, name: string): void {
  if (!LOCAL_HOSTS.has(parsed.host)) {
    throw new DataCopyError(
      "unsafe_url",
      `${name} host '${parsed.host}' is not local. Allowed in V0.1.44: localhost, 127.0.0.1, [::1], or the compose service 'postgres'.`,
    )
  }
  if (MAINTENANCE_DBS.has(parsed.database)) throw new DataCopyError("unsafe_url", `${name} names the maintenance database '${parsed.database}'.`)
}

export type SourceMode = "local"

/**
 * Validate both targets. The source is local by default. A future controlled
 * production export mode (reading a restored export on a non-local staging
 * host) is designed but DISABLED in V0.1.44: asking for it is refused.
 */
export function validateTargets(input: {
  sourceUrl: string | undefined
  targetUrl: string | undefined
  sourceMode?: string
  env?: Record<string, string | undefined>
  linkedProjectRef?: string | null
}): { source: ParsedDbUrl; target: ParsedDbUrl } {
  const env = input.env ?? {}
  for (const name of AMBIENT_PG_ENV) {
    if (env[name]) throw new DataCopyError("ambient_pg_env", `${name} is set; it could redirect a connection away from the named URL. Unset it.`)
  }
  const mode = input.sourceMode ?? "local"
  if (mode !== "local") {
    throw new DataCopyError(
      "production_mode_disabled",
      `Source mode '${mode}' is not enabled in V0.1.44. Only local sources (a restored export on this machine) are allowed. See docs/DATA_MIGRATION.md, "Production copy plan".`,
    )
  }
  const extraRefs = input.linkedProjectRef ? [input.linkedProjectRef] : []
  const source = parseDbUrl(input.sourceUrl, "CARTOONA_COPY_SOURCE_URL", extraRefs)
  const target = parseDbUrl(input.targetUrl, "CARTOONA_COPY_TARGET_URL", extraRefs)
  assertLocal(source, "CARTOONA_COPY_SOURCE_URL")
  assertLocal(target, "CARTOONA_COPY_TARGET_URL")
  const sameHost = (a: string) => (a === "localhost" || a === "::1" || a === "[::1]" ? "127.0.0.1" : a)
  if (sameHost(source.host) === sameHost(target.host) && source.port === target.port && source.database === target.database) {
    throw new DataCopyError("same_database", "Source and target are the same database. They must be different.")
  }
  return { source, target }
}

/**
 * Remove anything secret from text that leaves the process: every password
 * passed in, and any connection URL (replaced by a placeholder).
 */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "postgresql://<redacted>")
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("<redacted>")
  }
  return out
}

/** The password embedded in a URL, so it can be redacted from any output. */
export function urlPassword(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const p = new URL(raw.trim()).password
    return p ? decodeURIComponent(p) : undefined
  } catch {
    return undefined
  }
}

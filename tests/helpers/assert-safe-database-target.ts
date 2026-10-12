export const MAIN_PROJECT_REF = "oucyhmrnzahlhqjfqcge"
export const MAIN_SUPABASE_HOST = `${MAIN_PROJECT_REF}.supabase.co`
export const MIGRATION_TEST_REF = "guhhlshjvmiwwmixiulk"
export const MIGRATION_TEST_HOST = `${MIGRATION_TEST_REF}.supabase.co`

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"])

export type TargetKind =
  | "main"
  | "forbidden_known_project"
  | "local"
  | "explicit_disposable"
  | "unknown"

export interface SafeTargetResult {
  ok: boolean
  reason: string
  kind: TargetKind
}

interface ParsedUrl {
  hostname: string
  port: string | null
  projectRef: string | null
  isLocal: boolean
}

interface CollectedIdentifiers {
  urls: ParsedUrl[]
  rawRefs: string[]
  allowDestructive: boolean
  testRef: string | null
  /** CARTOONA_TEST_SUPABASE_URL, parsed. The explicit stateful target. */
  testUrl: ParsedUrl | null
  /** True when any supplied URL variable is set but unusable. Fails closed. */
  invalidUrlSupplied: boolean
}

interface ParsedRef {
  type: "project_ref" | "local"
  ref: string | null
  port: string | null
}

export function assertSafeDatabaseTarget(): SafeTargetResult {
  const collected = collectIdentifiers()
  const identity = identifyTarget(collected)

  switch (identity.kind) {
    case "main":
      return {
        ok: false,
        reason: `Refusing to run destructive tests against the main Cartoona project (${MAIN_PROJECT_REF}).`,
        kind: "main",
      }

    case "forbidden_known_project":
      return {
        ok: false,
        reason: `Refusing to run destructive tests against the forbidden project "${identity.ref}".`,
        kind: "forbidden_known_project",
      }

    case "unknown":
      return {
        ok: false,
        reason: `Could not identify Supabase target. Target must be positively identified as local or an explicit disposable project.${identity.ref ? ` [${identity.ref}]` : ""}`,
        kind: "unknown",
      }

    case "local":
      if (!collected.allowDestructive) {
        return {
          ok: false,
          reason: "CARTOONA_ALLOW_DESTRUCTIVE_TESTS is not set to 'true'. Set it to confirm the local target is disposable.",
          kind: "local",
        }
      }
      return { ok: true, reason: "ok", kind: "local" }

    case "explicit_disposable": {
      if (!collected.allowDestructive) {
        return {
          ok: false,
          reason: "CARTOONA_ALLOW_DESTRUCTIVE_TESTS is not set to 'true'. Set it to confirm the target is disposable.",
          kind: "explicit_disposable",
        }
      }
      return { ok: true, reason: "ok", kind: "explicit_disposable" }
    }
  }
}

/**
 * The Supabase URL the guard actually inspected.
 *
 * Stateful specs MUST build every request from this, never from a hardcoded
 * project ref. When a spec hardcodes its target, the guard's verdict and the
 * spec's writes describe two different projects: pointing the environment at a
 * disposable project makes the guard return `ok`, while the spec still writes
 * to whatever it hardcoded. Deriving both from one source is what makes the
 * guard's answer binding on the traffic.
 *
 * Throws when no target is configured, so a misconfigured run fails loudly
 * instead of silently falling back to a default project.
 */
export function guardedSupabaseUrl(): string {
  // The explicit stateful target wins. The runtime variables are only the
  // fallback for a local stack, where the guard needs no CARTOONA_TEST_* URL;
  // for a hosted target the guard has already required them to agree.
  const raw = (
    process.env.CARTOONA_TEST_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ""
  ).trim()
  if (!raw) {
    throw new Error(
      "No Supabase URL configured. Set CARTOONA_TEST_SUPABASE_URL to the disposable target before running stateful tests.",
    )
  }
  const parsed = parseSupabaseUrl(raw)
  if (!parsed) {
    throw new Error(`Supabase URL failed validation and cannot be used as a test target: ${raw}`)
  }
  return raw.replace(/\/+$/, "")
}

/**
 * Project ref of the guarded target, used to name the `sb-<ref>-auth-token`
 * cookie that `@supabase/ssr` reads. Local stacks have no project ref, so the
 * hostname stands in, matching how the client derives its storage key.
 */
export function guardedProjectRef(): string {
  const parsed = parseSupabaseUrl(guardedSupabaseUrl())
  if (!parsed) throw new Error("Guarded Supabase URL could not be parsed.")
  return parsed.isLocal ? parsed.hostname : (parsed.projectRef as string)
}

function collectIdentifiers(): CollectedIdentifiers {
  const allowDestructive = process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS?.trim() === "true"
  const testRef = normalizeRef(process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF)

  const present = (v: string | undefined): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null

  // Runtime URLs (what the app talks to) and the explicit stateful test URL.
  // Every one that is supplied must be usable and must agree - a URL that
  // fails validation is never silently dropped in favour of a valid sibling.
  const runtimeStrings = [present(process.env.NEXT_PUBLIC_SUPABASE_URL), present(process.env.SUPABASE_URL)]
  const testUrlString = present(process.env.CARTOONA_TEST_SUPABASE_URL)

  let invalidUrlSupplied = false
  const urls: ParsedUrl[] = []
  const seen = new Set<string>()
  for (const str of [...runtimeStrings, testUrlString]) {
    if (!str) continue
    const parsed = parseSupabaseUrl(str)
    if (!parsed) {
      invalidUrlSupplied = true
      continue
    }
    const key = `${parsed.hostname}:${parsed.port ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    urls.push(parsed)
  }

  const testUrl = testUrlString ? parseSupabaseUrl(testUrlString) : null

  const rawRefs = [
    normalizeRef(process.env.SUPABASE_PROJECT_REF),
    testRef,
  ].filter((v): v is string => v !== null)

  return { urls, rawRefs, allowDestructive, testRef, testUrl, invalidUrlSupplied }
}

/** Trim and lower-case a project ref; null when absent. Refs are case-insensitive. */
function normalizeRef(value: string | undefined): string | null {
  if (typeof value !== "string") return null
  const v = value.trim().toLowerCase()
  return v.length > 0 ? v : null
}

function parseSupabaseUrl(urlStr: string): ParsedUrl | null {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    return null
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (parsed.username) return null
  if (parsed.password) return null
  if (parsed.search) return null
  if (parsed.hash) return null
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null

  // WHATWG URL reports an IPv6 literal with brackets ("[::1]").
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const port = parsed.port || null

  if (LOCAL_HOSTNAMES.has(hostname)) {
    return { hostname, port, projectRef: null, isLocal: true }
  }

  const match = hostname.match(/^([^.]+)\.supabase\.co$/)
  if (!match) return null

  const projectRef = match[1]
  if (hostname !== `${projectRef}.supabase.co`) return null

  return { hostname, port, projectRef, isLocal: false }
}

function resolveToRefs(urls: ParsedUrl[], rawRefs: string[]): ParsedRef[] {
  const result: ParsedRef[] = []

  for (const u of urls) {
    if (u.isLocal) {
      result.push({ type: "local", ref: null, port: u.port })
    } else {
      result.push({ type: "project_ref", ref: u.projectRef, port: null })
    }
  }

  for (const r of rawRefs) {
    result.push({ type: "project_ref", ref: r, port: null })
  }

  return result
}

function allResolvedAgree(resolved: ParsedRef[]): boolean {
  if (resolved.length === 0) return false
  const first = resolved[0]
  for (const r of resolved.slice(1)) {
    if (r.type !== first.type) return false
    if (r.type === "project_ref" && r.ref !== first.ref) return false
    if (r.type === "local" && r.port !== first.port) return false
  }
  return true
}

function identifyTarget(collected: CollectedIdentifiers): {
  kind: TargetKind
  ref: string | null
} {
  const { urls, rawRefs } = collected

  if (urls.length === 0 && rawRefs.length === 0) {
    return { kind: "unknown", ref: null }
  }

  if (urls.length === 0 && rawRefs.length > 0) {
    return { kind: "unknown", ref: "no Supabase URL supplied" }
  }


  const forbidden = checkForbiddenIdentifiers(urls, rawRefs)
  if (forbidden) return forbidden

  if (collected.invalidUrlSupplied) {
    return { kind: "unknown", ref: "a supplied URL failed validation" }
  }

  const resolved = resolveToRefs(urls, rawRefs)

  if (resolved.length === 0) {
    return { kind: "unknown", ref: null }
  }

  if (!allResolvedAgree(resolved)) {
    return { kind: "unknown", ref: "identifiers disagree" }
  }

  const first = resolved[0]

  if (first.type === "local") {
    const portStr = first.port ? `:${first.port}` : ""
    return { kind: "local", ref: `localhost${portStr}` }
  }

  // Hosted: the stateful target must be named explicitly. Generic runtime
  // values (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL) never authorize a hosted
  // run on their own, however plausible they look.
  if (!collected.testUrl || !collected.testRef) {
    return {
      kind: "unknown",
      ref: "hosted stateful tests require CARTOONA_TEST_SUPABASE_URL and CARTOONA_TEST_SUPABASE_PROJECT_REF",
    }
  }

  if (first.ref === collected.testRef && collected.testUrl.projectRef === collected.testRef) {
    return { kind: "explicit_disposable", ref: first.ref }
  }

  return { kind: "unknown", ref: first.ref }
}

function checkForbiddenIdentifiers(
  urls: ParsedUrl[],
  rawRefs: string[],
): { kind: "main" | "forbidden_known_project"; ref: string } | null {
  for (const url of urls) {
    if (url.projectRef === MAIN_PROJECT_REF) {
      return { kind: "main", ref: MAIN_PROJECT_REF }
    }
    if (url.projectRef === MIGRATION_TEST_REF) {
      return { kind: "forbidden_known_project", ref: MIGRATION_TEST_REF }
    }
  }

  for (const ref of rawRefs) {
    if (ref === MAIN_PROJECT_REF) {
      return { kind: "main", ref: MAIN_PROJECT_REF }
    }
    if (ref === MIGRATION_TEST_REF) {
      return { kind: "forbidden_known_project", ref: MIGRATION_TEST_REF }
    }
  }

  return null
}

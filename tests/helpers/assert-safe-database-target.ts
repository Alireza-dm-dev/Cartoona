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

function collectIdentifiers(): CollectedIdentifiers {
  const allowDestructive = process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS?.trim() === "true"
  const testRef = process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF?.trim() || null

  const urlStrings = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())

  const seen = new Set<string>()
  const uniqueUrlStrings = urlStrings.filter((v) => {
    if (seen.has(v)) return false
    seen.add(v)
    return true
  })

  const urls: ParsedUrl[] = []
  for (const s of uniqueUrlStrings) {
    const parsed = parseSupabaseUrl(s)
    if (parsed) urls.push(parsed)
  }

  const rawRefs = [
    process.env.SUPABASE_PROJECT_REF,
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())

  return { urls, rawRefs, allowDestructive, testRef }
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

  const hostname = parsed.hostname.toLowerCase()
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

  if (urlStringsPresentButNoneParsed(collected)) {
    return { kind: "unknown", ref: "all URLs failed validation" }
  }

  const forbidden = checkForbiddenIdentifiers(urls, rawRefs)
  if (forbidden) return forbidden

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

  if (collected.testRef && first.ref === collected.testRef) {
    return { kind: "explicit_disposable", ref: first.ref }
  }

  return { kind: "unknown", ref: first.ref }
}

function urlStringsPresentButNoneParsed(collected: CollectedIdentifiers): boolean {
  const rawUrlCount = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0).length

  return rawUrlCount > 0 && collected.urls.length === 0
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

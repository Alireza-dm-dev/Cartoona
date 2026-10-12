import * as fs from "fs"
import * as path from "path"

/**
 * Load `.env.local` for a test run exactly the way Next.js does, and refuse to
 * guess when the file is ambiguous.
 *
 * Why this exists. The specs used to read the file with three different rules:
 * a first-wins loader here, and ~20 inline copies that assigned every key
 * unconditionally (last wins, overwriting the caller's environment). Next.js
 * itself is last-wins within a file but never overrides a variable the real
 * environment already set. With a duplicated Supabase block those rules named
 * different projects - the app could be talking to the disposable project
 * while a test helper believed it was on production, or the reverse.
 *
 * One rule now, shared by every spec and identical to Next.js:
 *   1. A variable already set in the real environment wins; the file only
 *      supplies what is missing.
 *   2. Within the file a repeated key resolves to its last value (what
 *      `@next/env` / dotenv do).
 *   3. A Supabase- or Cartoona-related key repeated with DIFFERENT values is
 *      an error, not a tie-break: the run stops before anything is resolved.
 *
 * Rule 3 is what makes the failure loud. A repeated key that agrees with
 * itself is harmless; one that disagrees means the file no longer says which
 * project is meant, and the safe answer is to refuse.
 */

/** Keys whose ambiguity can change which database a run touches. */
const GUARDED_KEY = /SUPABASE|CARTOONA_/

export interface ParsedEnvFile {
  /** Final value per key, last occurrence winning (Next.js behaviour). */
  values: Record<string, string>
  /** Guarded keys that appear more than once with differing values. */
  conflicts: string[]
}

function unquote(raw: string): string {
  const v = raw.trim()
  const quote = v[0]
  if ((quote === '"' || quote === "'" || quote === "`") && v.length >= 2 && v.endsWith(quote)) {
    const inner = v.slice(1, -1)
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : inner
  }
  // Unquoted: a trailing ` # comment` is not part of the value.
  return v.replace(/\s+#.*$/, "").trim()
}

/** Parse dotenv text the way Next.js does, reporting guarded-key conflicts. */
export function parseEnvFile(content: string): ParsedEnvFile {
  const values: Record<string, string> = {}
  const conflicts = new Set<string>()

  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const value = unquote(match[2])
    if (key in values && values[key] !== value && GUARDED_KEY.test(key)) conflicts.add(key)
    values[key] = value
  }

  return { values, conflicts: [...conflicts].sort() }
}

export interface LoadTestEnvOptions {
  /** Defaults to the repository's `.env.local`. */
  file?: string
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

export function loadTestEnv(options: LoadTestEnvOptions = {}): void {
  const file = options.file ?? path.resolve(__dirname, "../../.env.local")
  const env = options.env ?? process.env

  let content: string
  try {
    content = fs.readFileSync(file, "utf-8")
  } catch {
    // No .env.local is fine; the environment may already carry everything.
    return
  }

  const { values, conflicts } = parseEnvFile(content)
  if (conflicts.length > 0) {
    // Names only - never values.
    throw new Error(
      `Ambiguous environment file: ${conflicts.join(", ")} defined more than once with different values. ` +
        "Keep a single active block so the target is unambiguous.",
    )
  }

  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined && env[key] !== "") continue
    env[key] = value
  }
}

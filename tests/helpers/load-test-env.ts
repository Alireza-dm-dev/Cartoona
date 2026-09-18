import * as fs from "fs"
import * as path from "path"

/**
 * Load `.env.local` for a test run without overwriting what the caller set.
 *
 * The specs used to read the file and assign every key unconditionally, which
 * made the safety guard impossible to satisfy: `.env.local` points
 * NEXT_PUBLIC_SUPABASE_URL at the main project, so an operator who exported the
 * disposable target had it silently replaced by main before
 * `assertSafeDatabaseTarget()` ever looked. The guard then refused the run —
 * failing closed, correctly, but leaving no way to run a stateful spec at all.
 *
 * Precedence here is the usual one: the real environment wins, and the file
 * only supplies what is missing. That is what lets a run be aimed at the
 * disposable project from the outside, and it is why the guard's verdict
 * describes the same target the requests will actually reach.
 */
export function loadTestEnv(): void {
  try {
    const content = fs.readFileSync(path.resolve(__dirname, "../../.env.local"), "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq)
      // Already set by the caller: leave it alone.
      if (process.env[key] !== undefined && process.env[key] !== "") continue
      process.env[key] = trimmed.slice(eq + 1)
    }
  } catch {
    // No .env.local is fine; the environment may already carry everything.
  }
}

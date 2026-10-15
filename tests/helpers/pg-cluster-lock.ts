import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Cross-process lock for the opt-in real-PostgreSQL suites.
 *
 * Vitest runs test files in parallel workers, but roles are CLUSTER-wide:
 * migration 0009 does `ALTER ROLE cartoona_app`, and two databases migrating
 * at the same instant make PostgreSQL fail one of them with "tuple
 * concurrently updated". Each suite builds its own database, which is safe;
 * only the migrate step touches shared role rows, so only that step takes this
 * lock. A deployment never migrates concurrently, so the migration itself is
 * left as is.
 *
 * mkdir is atomic, so the directory is the lock. A lock older than the
 * timeout is considered abandoned (a crashed worker) and broken.
 */
const LOCK = path.join(os.tmpdir(), "cartoona-pg-cluster.lock")
const STALE_MS = 120_000
const POLL_MS = 100

export async function withPgClusterLock<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + STALE_MS * 2
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true })
      } catch {
        // released between the checks: retry
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the PostgreSQL cluster lock")
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }
  try {
    return await work()
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true })
  }
}

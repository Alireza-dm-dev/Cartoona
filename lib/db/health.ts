import { normalizePgError, DbConfigError } from "./errors";
import { getPool } from "./pool";
import type { Queryable } from "./types";

export type DbPingResult =
  | { ok: true; latencyMs: number }
  | { ok: false; kind: string };

/**
 * Readiness probe for the plain-PostgreSQL database: one `SELECT 1`.
 *
 * Never throws, and reports only a kind ("unavailable", "config", ...), never
 * a raw message or the target. Deliberately NOT wired into /api/health: that
 * endpoint is process liveness, and a database outage must not make the
 * orchestrator restart healthy app containers. A separate readiness check can
 * call this when a route first depends on PostgreSQL.
 */
export async function pingDatabase(db?: Queryable): Promise<DbPingResult> {
  const started = performance.now();
  try {
    await (db ?? getPool()).query("SELECT 1");
    return { ok: true, latencyMs: Math.round((performance.now() - started) * 100) / 100 };
  } catch (error) {
    const normalized = normalizePgError(error);
    return { ok: false, kind: normalized instanceof DbConfigError ? "config" : normalized.kind };
  }
}

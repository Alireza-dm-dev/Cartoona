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
export type SessionRoleCheck =
  | { ok: true }
  | { ok: false; reason: "superuser" | "not_app_member" | "owns_objects" | "privileged" | "check_failed" };

/**
 * Whether this connection runs as a RESTRICTED application login: a member of
 * `cartoona_app`, not a superuser, without CREATEROLE/CREATEDB/BYPASSRLS, and
 * owning nothing in `public` (so it cannot ALTER or DROP schema objects). A
 * service that should never hold owner rights calls this before reporting
 * ready, so a connection string accidentally naming the owner fails closed
 * instead of serving traffic with full rights.
 */
const SESSION_ROLE_SQL = `
  SELECT
    r.rolsuper,
    (r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS privileged,
    pg_catalog.pg_has_role(current_user, 'cartoona_app', 'MEMBER') AS app_member,
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relowner = r.oid
    ) AS owns_objects
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user`;

export async function checkSessionRole(db?: Queryable): Promise<SessionRoleCheck> {
  try {
    const result = await (db ?? getPool()).query<{
      rolsuper: boolean;
      privileged: boolean;
      app_member: boolean;
      owns_objects: boolean;
    }>(SESSION_ROLE_SQL);
    const row = result.rows[0];
    if (!row) return { ok: false, reason: "check_failed" };
    if (row.rolsuper) return { ok: false, reason: "superuser" };
    if (row.privileged) return { ok: false, reason: "privileged" };
    if (row.owns_objects) return { ok: false, reason: "owns_objects" };
    if (!row.app_member) return { ok: false, reason: "not_app_member" };
    return { ok: true };
  } catch {
    // `pg_has_role` raises when cartoona_app does not exist (0009 not applied).
    return { ok: false, reason: "check_failed" };
  }
}

/**
 * Whether the schema is at the migration head this build needs (V0.1.54).
 * schema_migrations is owner-only, so the restricted login cannot read it;
 * instead the catalog is asked whether a function created by the HEAD migration
 * exists AND this login may execute it (which also proves the grants ran).
 * HEAD_PROBE must name a function of the newest file in database/migrations;
 * tests/unit/startup-gate.test.ts fails when a new migration is added without
 * moving it.
 */
export const HEAD_PROBE = {
  migration: "0019_remove_supabase_db_dependencies",
  signature: "public.delete_example_trusted(uuid, uuid)",
} as const;

export type SchemaVersionCheck = { ok: true } | { ok: false; reason: "behind" | "check_failed" };

export async function checkSchemaHead(db?: Queryable): Promise<SchemaVersionCheck> {
  try {
    const result = await (db ?? getPool()).query<{ ready: boolean | null }>(
      "SELECT pg_catalog.has_function_privilege(current_user, to_regprocedure($1), 'EXECUTE') AS ready",
      [HEAD_PROBE.signature],
    );
    return result.rows[0]?.ready === true ? { ok: true } : { ok: false, reason: "behind" };
  } catch {
    // has_function_privilege(NULL oid) yields NULL; an error means the catalog could not be read.
    return { ok: false, reason: "check_failed" };
  }
}

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

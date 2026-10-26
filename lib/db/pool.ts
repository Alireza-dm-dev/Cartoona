import { Pool, type PoolConfig } from "pg";
import { DbConfigError, describeDbError } from "./errors";

/**
 * The process-wide PostgreSQL pool for the plain-PostgreSQL schema (V0.1.39).
 *
 * - Lazy: importing this module opens nothing and reads no environment, so
 *   `next build` and module evaluation never touch a database. The pool is
 *   created by the first `getPool()` call, at request time.
 * - One per process: the instance lives on `globalThis`, which also survives
 *   Next.js dev-mode module reloads (a module-level `let` would leak a new pool
 *   on every hot reload).
 * - Framework-free: plain `pg`, no Next.js or Supabase imports, so a future
 *   Fastify backend uses this module as is. Shutdown is the host's job: call
 *   `closePool()` from its close hook (Fastify `onClose`). No signal handlers
 *   are installed here; a library that grabs SIGTERM fights its host.
 *
 * DATABASE_URL names the target: `postgres:5432` from a container on the
 * compose network, `localhost:5433` from this Mac. It should name the
 * application login role, never the schema owner (docs/POSTGRES_DATA_ACCESS.md).
 */

/**
 * Defaults, overridable through env only where it is useful:
 *
 *  DB_POOL_MAX (5)                  PostgreSQL's default max_connections is 100,
 *                                   shared by every app replica, the future
 *                                   backend container, migrations and psql
 *                                   sessions. Five per process covers this app's
 *                                   concurrency (reads are short; the busiest page
 *                                   issues ~3 queries) and leaves headroom.
 *  DB_IDLE_TIMEOUT_MS (30000)       Return idle server connections after 30s.
 *  DB_CONNECTION_TIMEOUT_MS (5000)  Fail a checkout after 5s instead of queueing
 *                                   forever when the database is unreachable or
 *                                   the pool is exhausted (pg's default is "never").
 *
 * Fixed, not configurable: statement_timeout 15s per statement (bounds a
 * runaway query; the slowest business function runs in milliseconds), and
 * application_name "cartoona" so sessions are identifiable in pg_stat_activity.
 */
export const POOL_DEFAULTS = {
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
} as const;

const STATEMENT_TIMEOUT_MS = 15_000;

const LIMITS = {
  DB_POOL_MAX: { min: 1, max: 50 },
  DB_IDLE_TIMEOUT_MS: { min: 1_000, max: 600_000 },
  DB_CONNECTION_TIMEOUT_MS: { min: 250, max: 60_000 },
} as const;

/**
 * Hosts the data-access layer must never use. `DATABASE_URL` used to mean "the
 * Supabase direct connection string for CLI tools" (see older .env examples),
 * and the plain schema shares table names with the Supabase one, so a stale
 * value would quietly run these repositories against hosted Supabase with
 * owner rights and no RLS. Refused outright until cutover is deliberate.
 */
const FORBIDDEN_HOST = /(^|\.)supabase\.(co|com|net|in)$|(^|\.)pooler\.supabase\./i;
const FORBIDDEN_REFS = ["oucyhmrnzahlhqjfqcge", "guhhlshjvmiwwmixiulk", "bkctpxclggiqfllbjbre"];

type Env = Record<string, string | undefined>;

function intSetting(env: Env, name: keyof typeof LIMITS, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const { min, max } = LIMITS[name];
  if (!/^\d+$/.test(raw.trim())) throw new DbConfigError(`${name} must be an integer between ${min} and ${max}.`);
  const value = Number.parseInt(raw.trim(), 10);
  if (value < min || value > max) throw new DbConfigError(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

/**
 * TLS to PostgreSQL (V0.1.55). DATABASE_URL may not carry query parameters, so
 * `?sslmode=` is not available; TLS is its own setting:
 *
 *  DB_SSL_MODE (disable)   `disable` (private network / local compose) or
 *                          `verify-full`: encrypted, certificate chain AND host
 *                          name verified. No weaker mode exists on purpose
 *                          (`require` without verification is not protection).
 *  DB_SSL_CA               optional PEM text of the CA that signed the server
 *                          certificate, for hosts whose CA is not in Node's store.
 */
function sslSetting(env: Env): { ssl?: { rejectUnauthorized: true; ca?: string } } {
  const mode = env.DB_SSL_MODE?.trim() || "disable";
  if (mode === "disable") {
    if (env.DB_SSL_CA?.trim()) throw new DbConfigError("DB_SSL_CA is set but DB_SSL_MODE is not verify-full.");
    return {};
  }
  if (mode !== "verify-full") throw new DbConfigError("DB_SSL_MODE must be disable or verify-full.");
  const ca = env.DB_SSL_CA?.trim();
  if (ca && !ca.includes("-----BEGIN CERTIFICATE-----")) throw new DbConfigError("DB_SSL_CA must be PEM certificate text.");
  return { ssl: { rejectUnauthorized: true, ...(ca ? { ca: ca.replace(/\\n/g, "\n") } : {}) } };
}

/**
 * Build the pg pool configuration from the environment. Pure (no I/O) so it
 * can be tested on its own. Every error message is written here and never
 * echoes the connection string, so no password can leak through one.
 */
export function readPoolConfig(env: Env = process.env): PoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new DbConfigError("DATABASE_URL is not set. The PostgreSQL data-access layer needs it at runtime.");
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DbConfigError("DATABASE_URL is not a valid postgresql:// URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DbConfigError("DATABASE_URL must use the postgresql:// scheme.");
  }
  if (!url.hostname || url.pathname.length <= 1) {
    throw new DbConfigError("DATABASE_URL must name a host and a database.");
  }
  // Query parameters can override host, database or TLS (host=, options=, ...).
  if (url.search) {
    throw new DbConfigError("DATABASE_URL must not carry query parameters.");
  }
  const lower = connectionString.toLowerCase();
  if (FORBIDDEN_HOST.test(url.hostname) || FORBIDDEN_REFS.some((ref) => lower.includes(ref))) {
    throw new DbConfigError(
      "DATABASE_URL points at hosted Supabase. The plain-PostgreSQL data-access layer must not run against it.",
    );
  }

  return {
    connectionString,
    ...sslSetting(env),
    max: intSetting(env, "DB_POOL_MAX", POOL_DEFAULTS.max),
    idleTimeoutMillis: intSetting(env, "DB_IDLE_TIMEOUT_MS", POOL_DEFAULTS.idleTimeoutMillis),
    connectionTimeoutMillis: intSetting(env, "DB_CONNECTION_TIMEOUT_MS", POOL_DEFAULTS.connectionTimeoutMillis),
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "cartoona",
  };
}

const POOL_KEY = Symbol.for("cartoona.db.pool");
type PoolHolder = { [POOL_KEY]?: Pool };
const holder = globalThis as PoolHolder;

/**
 * The shared pool, created on first use. Throws `DbConfigError` when
 * DATABASE_URL is missing or unsafe - only here, at use, never at import.
 */
export function getPool(): Pool {
  const existing = holder[POOL_KEY];
  if (existing) return existing;

  const pool = new Pool(readPoolConfig());
  // An idle client losing its connection emits 'error' on the pool; unhandled,
  // that would crash the process. Log the safe fields only (no message, no
  // target, no password) and let the pool replace the client.
  pool.on("error", (error) => {
    console.error("[db] idle client error", describeDbError(error));
  });
  holder[POOL_KEY] = pool;
  return pool;
}

/** End the shared pool, if one was created. Safe to call more than once. */
export async function closePool(): Promise<void> {
  const pool = holder[POOL_KEY];
  if (!pool) return;
  delete holder[POOL_KEY];
  await pool.end();
}

#!/usr/bin/env node
/**
 * READ-ONLY cutover precheck (V0.1.55). Verifies, without changing anything:
 * target PostgreSQL version/TLS/extension, applied migrations vs the files in
 * database/migrations (including checksums), whether the target is empty or
 * populated (and, with a source, whether row counts match), source/target
 * identity, the Storage key checker's availability, backend /health + /ready,
 * and (optionally) whether the frontend write freeze is on.
 *
 *   CARTOONA_CUTOVER_CONFIRM=read-only-cutover-check \
 *   CARTOONA_CUTOVER_TARGET_DATABASE_URL=postgresql://<owner or read access>@host/cartoona \
 *   [CARTOONA_CUTOVER_SOURCE_DATABASE_URL=...  (restored staging copy of the Supabase dump)] \
 *   [CARTOONA_CUTOVER_BACKEND_URL=http://backend:4000] \
 *   [CARTOONA_CUTOVER_FRONTEND_URL=https://app.example CARTOONA_CUTOVER_APP_ORIGIN=https://app.example] \
 *   node scripts/ops/cutover-check.mjs [--expect-target empty|imported] [--expect-freeze on|off]
 *
 * Database work runs in one READ ONLY transaction that is rolled back. Over the
 * network it only issues GETs (/health, /ready) plus, when a freeze expectation
 * is given, one UNAUTHENTICATED POST with an empty JSON body that the frontend
 * rejects (freeze, CSRF or sign-in) before doing any work. Output is JSON of
 * pass/fail with counts and short fingerprints; never a URL, user, password,
 * key or row value. Exit 0 all checks pass, 4 a check failed, 2 refused/usage.
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { DATA_TABLES, classifyImportState, compareMigrations, countDifferences, interpretFreezeProbe, isHostedSupabase, isLoopback, targetFingerprint } from "./cutover-check-core.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n")
const refuse = (reason) => (out({ result: "refused", reason }), process.exit(2))
const env = process.env

if (env.CARTOONA_CUTOVER_CONFIRM !== "read-only-cutover-check") refuse("CARTOONA_CUTOVER_CONFIRM=read-only-cutover-check is required")
const targetUrl = env.CARTOONA_CUTOVER_TARGET_DATABASE_URL
const sourceUrl = env.CARTOONA_CUTOVER_SOURCE_DATABASE_URL
if (!targetUrl) refuse("CARTOONA_CUTOVER_TARGET_DATABASE_URL is required")
const expectTarget = arg("--expect-target")
const expectFreeze = arg("--expect-freeze")
if (![undefined, "empty", "imported"].includes(expectTarget) || ![undefined, "on", "off"].includes(expectFreeze)) refuse("bad --expect-target / --expect-freeze value")
if (expectTarget === "imported" && !sourceUrl) refuse("--expect-target imported needs CARTOONA_CUTOVER_SOURCE_DATABASE_URL")

const checks = []
const record = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra })

async function readOnly(connectionString, work) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 })
  await client.connect()
  try {
    await client.query("begin transaction read only")
    const result = await work(client)
    await client.query("rollback")
    return result
  } finally {
    await client.end()
  }
}

async function counts(client) {
  const result = {}
  for (const table of DATA_TABLES) {
    await client.query("savepoint t")
    try {
      result[table] = Number((await client.query(`select count(*) as n from public.${table}`)).rows[0].n)
      await client.query("release savepoint t")
    } catch {
      result[table] = null
      await client.query("rollback to savepoint t")
    }
  }
  return result
}

// ---- identity
let sameTarget = false
try {
  const t = targetFingerprint(targetUrl)
  record("target_not_supabase", !isHostedSupabase(targetUrl), "the target must never be a hosted Supabase database", { target: t })
  if (sourceUrl) {
    const s = targetFingerprint(sourceUrl)
    sameTarget = s === t
    record("source_target_distinct", !sameTarget, "source and target are different databases", { source: s, target: t })
    if (isHostedSupabase(sourceUrl)) record("source_is_staging_copy", false, "the source is the live hosted Supabase database; the runbook copies from a restored staging copy")
  }
} catch {
  refuse("a database URL is not a valid URL")
}

// ---- target database
let targetCounts = null
try {
  await readOnly(targetUrl, async (client) => {
    const v = Number((await client.query("select current_setting('server_version_num')::int as v")).rows[0].v)
    record("postgres_17", Math.floor(v / 10000) === 17, "target is PostgreSQL major 17", { serverVersionNum: v })
    const ssl = (await client.query("select coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false) as ssl")).rows[0].ssl
    record("target_tls", ssl || isLoopback(targetUrl), "a non-loopback target connection is encrypted", { tls: ssl })
    const ext = (await client.query("select count(*)::int as n from pg_extension where extname = 'pgcrypto'")).rows[0].n
    record("extension_pgcrypto", ext === 1, "pgcrypto is installed")

    const dir = join(root, "database", "migrations")
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => ({
      version: f.replace(/\.sql$/, ""),
      checksum: createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"),
    }))
    await client.query("savepoint m")
    try {
      const applied = (await client.query("select version, checksum from public.schema_migrations order by version")).rows
      await client.query("release savepoint m")
      const cmp = compareMigrations(applied, files)
      record("migrations", cmp.ok, "applied migrations equal database/migrations, checksums included", { files: files.length, applied: applied.length, missing: cmp.missing, extra: cmp.extra, changed: cmp.changed })
    } catch {
      await client.query("rollback to savepoint m")
      record("migrations", false, "public.schema_migrations is unreadable for this login (use the owner login for this check)")
    }

    const role = (await client.query("select rolsuper, rolcreaterole or rolcreatedb or rolbypassrls or rolreplication as privileged from pg_roles where rolname = current_user")).rows[0]
    record("login_kind", true, "informational: the login used by this check", { superuser: role.rolsuper, privileged: role.privileged })

    targetCounts = await counts(client)
  })
} catch (error) {
  record("target_connect", false, "could not connect to or read the target database", { code: error?.code ?? "unknown" })
}

if (targetCounts) {
  const unreadable = DATA_TABLES.filter((t) => targetCounts[t] === null)
  record("target_tables_readable", unreadable.length === 0, "every data table is readable", { unreadable })
  const state = classifyImportState(Object.fromEntries(Object.entries(targetCounts).map(([k, v]) => [k, v ?? 0])))
  if (expectTarget === "empty") record("target_empty", state === "empty", "the target holds no user data before the copy", { state })
  else record("target_state", true, "informational: target import state", { state })
}

// ---- source comparison
if (sourceUrl && !sameTarget) {
  try {
    const sourceCounts = await readOnly(sourceUrl, counts)
    if (expectTarget === "imported" && targetCounts) {
      const diffs = countDifferences(sourceCounts, targetCounts)
      record("counts_match_source", diffs.length === 0, "source and target row counts are equal for every data table", { differences: diffs })
    } else {
      record("source_counts", true, "informational: source row counts", { counts: sourceCounts })
    }
  } catch (error) {
    record("source_connect", false, "could not read the source database", { code: error?.code ?? "unknown" })
  }
}

// ---- tooling
const checker = join(root, "scripts", "ops", "storage-key-check.mjs")
record("storage_key_checker", existsSync(checker) && existsSync(join(root, "node_modules", "@supabase", "supabase-js")), "scripts/ops/storage-key-check.mjs and its client library are present")

// ---- backend
const get = async (base, path) => {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(8_000), redirect: "manual" })
  return { status: response.status, body: await response.json().catch(() => null) }
}
if (env.CARTOONA_CUTOVER_BACKEND_URL) {
  try {
    const health = await get(env.CARTOONA_CUTOVER_BACKEND_URL, "/health")
    record("backend_health", health.status === 200, "GET /health (liveness) is 200", { status: health.status })
    const ready = await get(env.CARTOONA_CUTOVER_BACKEND_URL, "/ready")
    record("backend_ready", ready.status === 200 && ready.body?.status === "ready", "GET /ready (database, restricted role, migration head) is 200 ready", { status: ready.status })
  } catch {
    record("backend_reachable", false, "the backend did not answer")
  }
}

// ---- write freeze probe
if (env.CARTOONA_CUTOVER_FRONTEND_URL && expectFreeze) {
  try {
    const response = await fetch(new URL("/api/coupons/validate", env.CARTOONA_CUTOVER_FRONTEND_URL), {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.CARTOONA_CUTOVER_APP_ORIGIN ?? env.CARTOONA_CUTOVER_FRONTEND_URL },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
      redirect: "manual",
    })
    const state = interpretFreezeProbe(response.status, await response.json().catch(() => null))
    record("write_freeze", state === (expectFreeze === "on" ? "frozen" : "not_frozen"), `the frontend write freeze is ${expectFreeze.toUpperCase()}`, { observed: state })
  } catch {
    record("write_freeze", false, "the frontend did not answer the freeze probe")
  }
} else if (expectFreeze) {
  record("write_freeze", false, "--expect-freeze needs CARTOONA_CUTOVER_FRONTEND_URL")
}

const failed = checks.filter((c) => !c.ok)
out({ result: failed.length === 0 ? "pass" : "fail", checks, failed: failed.map((c) => c.id) })
process.exit(failed.length === 0 ? 0 : 4)

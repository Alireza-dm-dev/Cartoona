import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import { Client } from "pg"
import { backfillSupabaseIdentities } from "./identity"
import { ALL_TABLES, COPIED_TABLES, META_SCHEMA, PHASES, TOOL_VERSION, type PhaseSpec, type TableSpec } from "./mapping"
import {
  checkSourceSchema,
  checkTargetRole,
  checkTargetSchema,
  classifyTarget,
  databaseIdentity,
  nonInitialTables,
  publicTables,
  tableCounts,
  type ColumnInfo,
} from "./preflight"
import { DataCopyError, redact, urlPassword, validateTargets } from "./safety"
import { failures, readForeignKeys, runChecks, summarize, warnings, type CheckResult, type Queryable } from "./validate"

/**
 * Supabase-shaped PostgreSQL -> plain PostgreSQL data copy (V0.1.44).
 *
 * Transactions:
 *  - Source: ONE `REPEATABLE READ READ ONLY` transaction for the whole run, so
 *    every table, checksum and check sees the same snapshot.
 *  - Target: one transaction PER PHASE (PHASES in mapping.ts). A phase either
 *    commits completely, together with its row in cartoona_data_copy.phases,
 *    or rolls back completely. Resuming continues at the first phase without
 *    a row. Trigger bypass is `ALTER TABLE ... DISABLE TRIGGER <name>` inside
 *    that transaction: a rollback (or a crash, which the server rolls back)
 *    restores the trigger, and the phase re-enables and verifies it before
 *    committing.
 *  - Foreign keys, CHECKs and unique indexes stay active throughout: an
 *    integrity error aborts the phase. No session_replication_role, no
 *    DISABLE TRIGGER ALL.
 */

export interface CopyOptions {
  sourceUrl: string | undefined
  targetUrl: string | undefined
  /** database/migrations of this checkout (checksums are verified against it). */
  migrationsDir: string
  sourceMode?: string
  env?: Record<string, string | undefined>
  linkedProjectRef?: string | null
  /** Rows per batch read from the source. */
  batchSize?: number
  /** Stop (successfully) after this phase commits - staged runs, resumability drills. */
  stopAfterPhase?: string
  /** Also write the manifest JSON here. */
  manifestPath?: string
  log?: (line: string) => void
}

export type Outcome = "completed" | "resumed_completed" | "verified_noop" | "stopped"

export interface TableReport {
  table: string
  strategy: string
  rows: number
  checksum: string
  durationMs: number
}

export interface Manifest {
  tool: string
  outcome: Outcome | "failed_validation"
  runId: string
  startedAt: string
  completedAt: string | null
  source: { schemaFingerprint: string; dataFingerprint: string; supabaseMigration: string | null }
  target: { migrations: string[]; migrationsFingerprint: string; serverVersion: string }
  phases: { name: string; durationMs: number; tables: TableReport[] }[]
  bypassedTriggers: { table: string; trigger: string; reason: string }[]
  identityBackfill: { inserted: number; alreadyPresent: number } | null
  validation: {
    durationMs: number
    source: ReturnType<typeof summarize>
    target: ReturnType<typeof summarize> | null
    preservation: { tables: number; mismatches: string[] } | null
  }
  timingsMs: { preflight: number; copy: number; validation: number; total: number }
}

export interface CopyResult {
  outcome: Outcome
  manifest: Manifest
  sourceChecks: CheckResult[]
  targetChecks: CheckResult[]
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

const SESSION_SETUP = [
  "SET TimeZone = 'UTC'",
  "SET DateStyle = 'ISO, YMD'",
  "SET IntervalStyle = 'postgres'",
  "SET extra_float_digits = 3",
  "SET client_min_messages = warning",
]

/** count + order-independent-of-storage checksum of exactly `columns`, ordered by the primary key. */
async function tableChecksum(db: Queryable, spec: TableSpec, columns: ColumnInfo[]): Promise<{ rows: number; checksum: string }> {
  const cols = columns.map((c) => ident(c.name)).join(", ")
  const order = spec.pk.map(ident).join(", ")
  const { rows } = await db.query<{ n: string; sum: string }>(
    `SELECT count(*)::bigint AS n, md5(coalesce(string_agg(md5(ROW(${cols})::text), '' ORDER BY ${order}), '')) AS sum FROM public.${ident(spec.table)}`,
  )
  return { rows: Number(rows[0].n), checksum: rows[0].sum }
}

async function sourceFingerprint(source: Queryable, columns: Map<string, ColumnInfo[]>) {
  const perTable: Record<string, { rows: number; checksum: string }> = {}
  for (const spec of COPIED_TABLES) perTable[spec.table] = await tableChecksum(source, spec, columns.get(spec.table)!)
  return { perTable, fingerprint: sha256(JSON.stringify(perTable)) }
}

async function setTriggers(target: Queryable, table: string, triggers: { name: string }[], enable: boolean) {
  for (const t of triggers) {
    await target.query(`ALTER TABLE public.${ident(table)} ${enable ? "ENABLE" : "DISABLE"} TRIGGER ${ident(t.name)}`)
  }
}

/**
 * Stream one table: keyset-paginated reads from the source snapshot, each
 * batch inserted with json_populate_recordset so every value keeps its
 * PostgreSQL type and precision (microsecond timestamps, jsonb, arrays).
 */
async function copyTable(
  source: Queryable,
  target: Queryable,
  spec: TableSpec,
  columns: ColumnInfo[],
  batchSize: number,
): Promise<number> {
  const cols = columns.map((c) => ident(c.name)).join(", ")
  const order = spec.pk.map(ident).join(", ")
  const pkTypes = spec.pk.map((k) => columns.find((c) => c.name === k)!.type)
  const nulled = spec.secondPass?.column
  const insertCols = columns.map((c) => (c.name === nulled ? `NULL AS ${ident(c.name)}` : ident(c.name))).join(", ")
  let last: unknown[] | null = null
  let total = 0
  for (;;) {
    const where = last
      ? `WHERE (${order}) > (${spec.pk.map((_, i) => `$${i + 1}::${pkTypes[i]}`).join(", ")})`
      : ""
    const { rows } = await source.query<{ data: string | null }>(
      `SELECT json_agg(r)::text AS data FROM (SELECT ${cols} FROM public.${ident(spec.table)} ${where} ORDER BY ${order} LIMIT ${batchSize}) r`,
      last ?? [],
    )
    const data = rows[0]?.data
    if (!data) break
    const parsed = JSON.parse(data) as Record<string, unknown>[]
    await target.query(
      `INSERT INTO public.${ident(spec.table)} (${cols}) SELECT ${insertCols} FROM json_populate_recordset(NULL::public.${ident(spec.table)}, $1::json)`,
      [data],
    )
    total += parsed.length
    const tail = parsed[parsed.length - 1]
    last = spec.pk.map((k) => tail[k])
    if (parsed.length < batchSize) break
  }
  return total
}

/** Second pass for a foreign-key cycle: set the deferred column from the source. */
async function applySecondPass(source: Queryable, target: Queryable, spec: TableSpec, batchSize: number): Promise<number> {
  const sp = spec.secondPass!
  const pk = spec.pk[0]
  let lastId: string | null = null
  let total = 0
  for (;;) {
    const page: { rows: { data: string | null }[] } = await source.query<{ data: string | null }>(
      `SELECT json_agg(r)::text AS data FROM (SELECT ${ident(pk)}, ${ident(sp.column)} FROM public.${ident(spec.table)}
        WHERE ${ident(sp.column)} IS NOT NULL ${lastId ? `AND ${ident(pk)} > $1::uuid` : ""} ORDER BY ${ident(pk)} LIMIT ${batchSize}) r`,
      lastId ? [lastId] : [],
    )
    const data: string | null | undefined = page.rows[0]?.data
    if (!data) break
    const parsed = JSON.parse(data) as Record<string, string>[]
    const res: { rowCount?: number | null } = await target.query(
      `UPDATE public.${ident(spec.table)} t SET ${ident(sp.column)} = x.${ident(sp.column)}
       FROM json_populate_recordset(NULL::public.${ident(spec.table)}, $1::json) x WHERE t.${ident(pk)} = x.${ident(pk)}`,
      [data],
    )
    if ((res.rowCount ?? 0) !== parsed.length) throw new Error(`${spec.table}.${sp.column}: second pass matched ${res.rowCount} of ${parsed.length} rows`)
    total += parsed.length
    lastId = parsed[parsed.length - 1][pk]
    if (parsed.length < batchSize) break
  }
  return total
}

const META_DDL = `
  CREATE SCHEMA ${META_SCHEMA};
  REVOKE ALL ON SCHEMA ${META_SCHEMA} FROM PUBLIC;
  COMMENT ON SCHEMA ${META_SCHEMA} IS 'Data-copy bookkeeping (V0.1.44 tool). Not used by the application; no application role has access.';
  CREATE TABLE ${META_SCHEMA}.runs (
    id uuid PRIMARY KEY,
    one_run boolean NOT NULL DEFAULT true UNIQUE CHECK (one_run),
    status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed_validation')),
    tool_version text NOT NULL,
    source_schema_fingerprint text NOT NULL,
    source_data_fingerprint text NOT NULL,
    source_supabase_migration text,
    target_migrations_fingerprint text NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    manifest jsonb
  );
  CREATE TABLE ${META_SCHEMA}.phases (
    run_id uuid NOT NULL REFERENCES ${META_SCHEMA}.runs (id),
    phase text NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL,
    row_counts jsonb NOT NULL,
    PRIMARY KEY (run_id, phase)
  );`

export async function runDataCopy(opts: CopyOptions): Promise<CopyResult> {
  const t0 = Date.now()
  const { source: src, target: tgt } = validateTargets({
    sourceUrl: opts.sourceUrl,
    targetUrl: opts.targetUrl,
    sourceMode: opts.sourceMode,
    env: opts.env,
    linkedProjectRef: opts.linkedProjectRef,
  })
  const secrets = [urlPassword(opts.sourceUrl), urlPassword(opts.targetUrl)]
  const log = (line: string) => opts.log?.(redact(line, secrets))
  const batchSize = opts.batchSize ?? 2000
  log(`data-copy ${TOOL_VERSION}: source ${src.label} -> target ${tgt.label} (passwords not shown)`)

  const source = new Client({ connectionString: opts.sourceUrl!.trim(), application_name: "cartoona-data-copy-source" })
  const target = new Client({ connectionString: opts.targetUrl!.trim(), application_name: "cartoona-data-copy-target" })
  // A dropped connection emits 'error' on the client; without a listener it would crash the process with the raw error.
  source.on("error", () => undefined)
  target.on("error", () => undefined)

  try {
    try {
      await source.connect()
      await target.connect()
    } catch (e) {
      throw new DataCopyError("connect_failed", `Could not connect: ${redact(String((e as Error).message ?? e), secrets)}`, { exitCode: 2 })
    }
    for (const q of SESSION_SETUP) {
      await source.query(q)
      await target.query(q)
    }
    await target.query("SET lock_timeout = '10s'")

    if ((await databaseIdentity(source)) === (await databaseIdentity(target))) {
      throw new DataCopyError("same_database", "Source and target URLs reach the same database. They must be different.")
    }

    // ── preflight (nothing is written before every check passes) ──
    const tPre = Date.now()
    const targetSchema = await checkTargetSchema(target, opts.migrationsDir)
    await checkTargetRole(target)
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const sourceSchema = await checkSourceSchema(source, target)
    const fingerprint = await sourceFingerprint(source, sourceSchema.columns)
    const serverVersion = (await target.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0].v
    const state = await classifyTarget(target)
    const foreignKeys = await readForeignKeys(target)
    const tVal0 = Date.now()
    const sourceChecks = await runChecks(source, "source", foreignKeys, await publicTables(source))
    let validationMs = Date.now() - tVal0
    const preflightMs = Date.now() - tPre - validationMs

    for (const w of warnings(sourceChecks)) log(`warning (source): ${w.check} x${w.count} e.g. ${w.sample.slice(0, 3).join("; ")}`)

    const manifest: Manifest = {
      tool: TOOL_VERSION,
      outcome: "completed",
      runId: "",
      startedAt: new Date(t0).toISOString(),
      completedAt: null,
      source: { schemaFingerprint: sourceSchema.schemaFingerprint, dataFingerprint: fingerprint.fingerprint, supabaseMigration: sourceSchema.supabaseMigration },
      target: { migrations: targetSchema.migrations, migrationsFingerprint: targetSchema.fingerprint, serverVersion },
      phases: [],
      bypassedTriggers: ALL_TABLES.flatMap((t) => [
        ...(t.bypassTriggers ?? []).map((b) => ({ table: t.table, trigger: b.name, reason: b.reason })),
        ...(t.secondPass?.bypassTriggers ?? []).map((b) => ({ table: t.table, trigger: b.name, reason: b.reason })),
      ]),
      identityBackfill: null,
      validation: { durationMs: 0, source: summarize(sourceChecks), target: null, preservation: null },
      timingsMs: { preflight: preflightMs, copy: 0, validation: 0, total: 0 },
    }

    const validateTarget = async () => {
      const t = Date.now()
      const checks = await runChecks(target, "target", foreignKeys, await publicTables(target))
      const mismatches: string[] = []
      for (const spec of COPIED_TABLES) {
        const got = await tableChecksum(target, spec, sourceSchema.columns.get(spec.table)!)
        const want = fingerprint.perTable[spec.table]
        if (got.rows !== want.rows) mismatches.push(`${spec.table}: ${got.rows} row(s) in target, ${want.rows} in source`)
        else if (got.checksum !== want.checksum) mismatches.push(`${spec.table}: content checksum differs from source`)
      }
      validationMs += Date.now() - t
      return { checks, mismatches }
    }

    // ── a completed copy: verify, never write (Mode B) ──
    if (state.kind === "run" && state.run.status === "completed") {
      if (state.run.source_data_fingerprint !== fingerprint.fingerprint || state.run.source_schema_fingerprint !== sourceSchema.schemaFingerprint) {
        throw new DataCopyError("target_holds_other_copy", "The target already holds a completed copy of a DIFFERENT source state. Recreate the target to copy again.", { exitCode: 3 })
      }
      const { checks, mismatches } = await validateTarget()
      if (failures(checks).length > 0 || mismatches.length > 0) {
        throw new DataCopyError("validation_failed", "The completed target no longer matches its source or fails validation. Nothing was changed.", {
          exitCode: 4,
          details: [...mismatches, ...failures(checks).map((f) => `${f.check} x${f.count}: ${f.sample.join("; ")}`)],
        })
      }
      log("target already holds a completed copy of this exact source state: verified, nothing written (no-op)")
      manifest.outcome = "verified_noop"
      manifest.runId = state.run.id
      manifest.validation.target = summarize(checks)
      manifest.validation.preservation = { tables: COPIED_TABLES.length, mismatches }
      manifest.validation.durationMs = validationMs
      manifest.completedAt = new Date().toISOString()
      manifest.timingsMs = { preflight: preflightMs, copy: 0, validation: validationMs, total: Date.now() - t0 }
      writeManifest(opts.manifestPath, manifest)
      return { outcome: "verified_noop", manifest, sourceChecks, targetChecks: checks }
    }
    if (state.kind === "run" && state.run.status === "failed_validation") {
      throw new DataCopyError("target_state_unsupported", "A previous copy into this target failed validation. Discard the target (drop and re-migrate it); it is never repaired in place.", { exitCode: 3 })
    }

    // ── refuse a broken source before writing anything ──
    const sourceErrors = failures(sourceChecks)
    if (sourceErrors.length > 0) {
      throw new DataCopyError("source_integrity", `The source fails ${sourceErrors.length} integrity/reconciliation check(s). Nothing was written; nothing is auto-repaired.`, {
        exitCode: 4,
        details: sourceErrors.map((f) => `${f.check} x${f.count}: ${f.sample.join("; ")}`),
      })
    }

    // ── run bookkeeping ──
    let runId: string
    let done = new Set<string>()
    const resuming = state.kind === "run"
    if (state.kind === "run") {
      if (state.run.source_data_fingerprint !== fingerprint.fingerprint || state.run.source_schema_fingerprint !== sourceSchema.schemaFingerprint) {
        throw new DataCopyError("source_changed", "The source changed since this interrupted copy started. Discard the target and start again from a fresh one.", { exitCode: 3 })
      }
      runId = state.run.id
      done = state.donePhases
      const pending = PHASES.filter((p) => !done.has(p.name)).flatMap((p) => p.tables)
      const dirty = nonInitialTables(await tableCounts(target, pending), pending)
      if (dirty.length > 0) {
        throw new DataCopyError("target_state_unsupported", "Tables of unfinished phases are not in their initial state. Discard the target.", { exitCode: 3, details: dirty })
      }
      log(`resuming run ${runId}: ${done.size} of ${PHASES.length} phase(s) already committed`)
    } else {
      runId = randomUUID()
      await target.query("BEGIN")
      try {
        await target.query(META_DDL)
        await target.query(
          `INSERT INTO ${META_SCHEMA}.runs (id, status, tool_version, source_schema_fingerprint, source_data_fingerprint, source_supabase_migration, target_migrations_fingerprint, started_at)
           VALUES ($1, 'in_progress', $2, $3, $4, $5, $6, $7)`,
          [runId, TOOL_VERSION, sourceSchema.schemaFingerprint, fingerprint.fingerprint, sourceSchema.supabaseMigration, targetSchema.fingerprint, manifest.startedAt],
        )
        await target.query("COMMIT")
      } catch (e) {
        await target.query("ROLLBACK").catch(() => undefined)
        throw e
      }
    }
    manifest.runId = runId

    // ── phases ──
    const tCopy = Date.now()
    for (const phase of PHASES) {
      if (done.has(phase.name)) continue
      const report = await runPhase(phase, { source, target, runId, columns: sourceSchema.columns, batchSize, log, secrets, manifest, expected: fingerprint.perTable })
      manifest.phases.push(report)
      if (opts.stopAfterPhase === phase.name) {
        log(`stopped after phase '${phase.name}' as requested; rerun to resume`)
        manifest.outcome = "stopped"
        manifest.timingsMs = { preflight: preflightMs, copy: Date.now() - tCopy, validation: validationMs, total: Date.now() - t0 }
        writeManifest(opts.manifestPath, manifest)
        return { outcome: "stopped", manifest, sourceChecks, targetChecks: [] }
      }
    }
    const copyMs = Date.now() - tCopy

    // ── validation ──
    const { checks, mismatches } = await validateTarget()
    const ok = failures(checks).length === 0 && mismatches.length === 0
    manifest.outcome = ok ? (resuming ? "resumed_completed" : "completed") : "failed_validation"
    manifest.validation.target = summarize(checks)
    manifest.validation.preservation = { tables: COPIED_TABLES.length, mismatches }
    manifest.validation.durationMs = validationMs
    manifest.completedAt = new Date().toISOString()
    manifest.timingsMs = { preflight: preflightMs, copy: copyMs, validation: validationMs, total: Date.now() - t0 }
    await target.query(`UPDATE ${META_SCHEMA}.runs SET status = $2, completed_at = now(), manifest = $3 WHERE id = $1`, [
      runId,
      ok ? "completed" : "failed_validation",
      JSON.stringify(manifest),
    ])
    writeManifest(opts.manifestPath, manifest)
    for (const w of warnings(checks)) log(`warning (target): ${w.check} x${w.count}`)
    if (!ok) {
      throw new DataCopyError("validation_failed", "The copied target fails validation and is marked failed_validation. Discard it.", {
        exitCode: 4,
        details: [...mismatches, ...failures(checks).map((f) => `${f.check} x${f.count}: ${f.sample.join("; ")}`)],
      })
    }
    log(`copy ${manifest.outcome}: ${COPIED_TABLES.length} tables, ${manifest.phases.reduce((n, p) => n + p.tables.reduce((m, t) => m + t.rows, 0), 0)} rows, validated in ${validationMs} ms, total ${manifest.timingsMs.total} ms`)
    return { outcome: manifest.outcome as Outcome, manifest, sourceChecks, targetChecks: checks }
  } catch (e) {
    if (e instanceof DataCopyError) {
      throw new DataCopyError(e.code, redact(e.message, secrets), { exitCode: e.exitCode, details: e.details.map((d) => redact(d, secrets)) })
    }
    throw new DataCopyError("unexpected", redact(String((e as Error)?.message ?? e), secrets), { exitCode: 1 })
  } finally {
    await source.query("ROLLBACK").catch(() => undefined)
    await source.end().catch(() => undefined)
    await target.end().catch(() => undefined)
  }
}

interface PhaseContext {
  source: Queryable
  target: Queryable
  runId: string
  columns: Map<string, ColumnInfo[]>
  batchSize: number
  log: (line: string) => void
  secrets: (string | undefined)[]
  manifest: Manifest
  /** Source count + checksum per table, from the run's snapshot. */
  expected: Record<string, { rows: number; checksum: string }>
}

async function runPhase(phase: PhaseSpec, ctx: PhaseContext): Promise<Manifest["phases"][number]> {
  const { source, target } = ctx
  const t0 = Date.now()
  const tables: TableReport[] = []
  let current = `at table ${phase.tables[0]?.table ?? "?"}`
  await target.query("BEGIN")
  try {
    for (const spec of phase.tables) {
      current = `at table ${spec.table}`
      const ts = Date.now()
      if (spec.strategy === "derived") {
        ctx.manifest.identityBackfill = await backfillSupabaseIdentities(target)
      } else {
        if (spec.strategy === "reference_replace") {
          // Seed rows from 0008 only (classifyTarget proved it); replaced, never merged.
          await target.query(`DELETE FROM public.${ident(spec.table)}`)
        }
        const bypass = spec.bypassTriggers ?? []
        await setTriggers(target, spec.table, bypass, false)
        await copyTable(source, target, spec, ctx.columns.get(spec.table)!, ctx.batchSize)
        await setTriggers(target, spec.table, bypass, true)
      }
      for (const earlier of phase.tables) {
        if (earlier.secondPass?.after !== spec.table) continue
        await setTriggers(target, earlier.table, earlier.secondPass.bypassTriggers, false)
        await applySecondPass(source, target, earlier, ctx.batchSize)
        await setTriggers(target, earlier.table, earlier.secondPass.bypassTriggers, true)
      }
      tables.push({ table: spec.table, strategy: spec.strategy, rows: 0, checksum: "", durationMs: Date.now() - ts })
    }

    current = "in end-of-phase verification"
    // Before COMMIT: every trigger of this phase's tables is enabled again, and every copied table matches the source.
    const disabled = await target.query<{ t: string }>(
      `SELECT c.relname || '.' || t.tgname AS t FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'O' AND c.relname = ANY ($1::text[])`,
      [phase.tables.map((t) => t.table)],
    )
    if (disabled.rows.length > 0) throw new Error(`triggers still disabled: ${disabled.rows.map((r) => r.t).join(", ")}`)
    for (const report of tables) {
      const spec = phase.tables.find((t) => t.table === report.table)!
      const columns = spec.strategy === "derived" ? [{ name: "id", type: "uuid" }, { name: "user_id", type: "uuid" }, { name: "provider", type: "text" }, { name: "provider_subject", type: "text" }, { name: "created_at", type: "timestamptz" }] : ctx.columns.get(spec.table)!
      const got = await tableChecksum(target, spec, columns)
      report.rows = got.rows
      report.checksum = got.checksum
      if (spec.strategy !== "derived") {
        const want = ctx.expected[spec.table]
        if (want.rows !== got.rows || want.checksum !== got.checksum) {
          throw new Error(
            want.rows !== got.rows
              ? `${spec.table}: ${got.rows} row(s) in target, ${want.rows} in source`
              : `${spec.table}: content differs from the source (checksum mismatch)`,
          )
        }
      }
    }
    await target.query(`INSERT INTO ${META_SCHEMA}.phases (run_id, phase, duration_ms, row_counts) VALUES ($1, $2, $3, $4)`, [
      ctx.runId,
      phase.name,
      Date.now() - t0,
      JSON.stringify(Object.fromEntries(tables.map((t) => [t.table, t.rows]))),
    ])
    await target.query("COMMIT")
  } catch (e) {
    await target.query("ROLLBACK").catch(() => undefined)
    if (e instanceof DataCopyError) throw e
    const message = redact(String((e as Error)?.message ?? e), ctx.secrets)
    const detail = (e as { detail?: string }).detail
    throw new DataCopyError("phase_failed", `Phase '${phase.name}' failed ${current} and was rolled back: ${message}`, {
      exitCode: 4,
      details: detail ? [redact(detail, ctx.secrets)] : [],
    })
  }
  const durationMs = Date.now() - t0
  ctx.log(`phase ${phase.name}: ${tables.map((t) => `${t.table}=${t.rows}`).join(" ")} (${durationMs} ms)`)
  return { name: phase.name, durationMs, tables }
}

function writeManifest(file: string | undefined, manifest: Manifest) {
  if (!file) return
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
}

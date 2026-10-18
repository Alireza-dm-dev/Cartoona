import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  ALL_TABLES,
  COPIED_TABLES,
  EXPECTED_TARGET_MIGRATIONS,
  META_SCHEMA,
  REFERENCE_SEED_COUNTS,
  type TableSpec,
} from "./mapping"
import { DataCopyError } from "./safety"
import type { Queryable } from "./validate"

/**
 * Read-only checks that run before the copy writes anything (V0.1.44).
 */

export interface ColumnInfo {
  name: string
  type: string
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

async function readColumns(db: Queryable, tables: string[]): Promise<Map<string, ColumnInfo[]>> {
  const { rows } = await db.query<{ table_name: string; column_name: string; udt: string }>(
    `SELECT table_name, column_name, udt_name AS udt FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY ($1::text[]) ORDER BY table_name, ordinal_position`,
    [tables],
  )
  const map = new Map<string, ColumnInfo[]>()
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, [])
    map.get(r.table_name)!.push({ name: r.column_name, type: r.udt })
  }
  return map
}

export async function publicTables(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)
  return new Set(rows.map((r) => r.t))
}

export interface SourceSchema {
  /** Per copied table: the columns read from the source and written to the target, in target order. */
  columns: Map<string, ColumnInfo[]>
  schemaFingerprint: string
  /** Latest Supabase migration version when the source still has supabase_migrations (a restored full dump). */
  supabaseMigration: string | null
}

/**
 * Source compatibility: every copied table exists with exactly the target's
 * columns (minus target-only ones) and the same types. A missing column, an
 * extra column (data that would be dropped) or a type change is refused.
 */
export async function checkSourceSchema(source: Queryable, target: Queryable): Promise<SourceSchema> {
  const names = COPIED_TABLES.map((t) => t.table)
  const sourceTables = await publicTables(source)
  if (sourceTables.has("user_identities") || sourceTables.has("schema_migrations")) {
    throw new DataCopyError(
      "source_schema_incompatible",
      "The source has public.user_identities/schema_migrations: it looks like a plain-schema database, not the Supabase-shaped source. Check CARTOONA_COPY_SOURCE_URL.",
    )
  }
  const want = await readColumns(target, names)
  const have = await readColumns(source, names)
  const problems: string[] = []
  const columns = new Map<string, ColumnInfo[]>()
  for (const spec of COPIED_TABLES) {
    const targetCols = (want.get(spec.table) ?? []).filter((c) => !(spec.targetOnlyColumns ?? []).includes(c.name))
    const sourceCols = have.get(spec.table)
    if (!sourceCols) {
      problems.push(`missing table public.${spec.table}`)
      continue
    }
    const byName = new Map(sourceCols.map((c) => [c.name, c]))
    for (const col of targetCols) {
      const found = byName.get(col.name)
      if (!found) problems.push(`missing column public.${spec.table}.${col.name}`)
      else if (found.type !== col.type) problems.push(`type mismatch public.${spec.table}.${col.name}: source ${found.type}, target ${col.type}`)
    }
    const known = new Set(targetCols.map((c) => c.name))
    for (const col of sourceCols) {
      if (!known.has(col.name)) problems.push(`source column public.${spec.table}.${col.name} has no target column (its data would be lost)`)
    }
    columns.set(spec.table, targetCols)
  }
  if (problems.length > 0) {
    throw new DataCopyError("source_schema_incompatible", `The source schema does not match the audited Supabase shape (${problems.length} problem(s)).`, { details: problems })
  }
  const fingerprintLines = [...columns.entries()].flatMap(([t, cols]) => cols.map((c) => `${t}.${c.name} ${c.type}`)).sort()

  let supabaseMigration: string | null = null
  const hasHistory = await source.query<{ ok: boolean }>(`SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS ok`)
  if (hasHistory.rows[0]?.ok) {
    const v = await source.query<{ v: string | null }>(`SELECT max(version)::text AS v FROM supabase_migrations.schema_migrations`)
    supabaseMigration = v.rows[0]?.v ?? null
  }
  return { columns, schemaFingerprint: sha256(fingerprintLines.join("\n")), supabaseMigration }
}

/**
 * Target compatibility: schema_migrations holds exactly the audited set, in
 * order, each with the sha256 of the file in this checkout; the checkout holds
 * no newer migration the mapping has not been audited against.
 */
export async function checkTargetSchema(target: Queryable, migrationsDir: string): Promise<{ migrations: string[]; fingerprint: string }> {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort()
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_TARGET_MIGRATIONS)) {
    throw new DataCopyError(
      "target_schema_mismatch",
      `database/migrations holds ${files.length} file(s), but this tool was audited against exactly ${EXPECTED_TARGET_MIGRATIONS.length} (0001-0011). Re-audit the mapping before copying.`,
      { details: files.filter((f) => !EXPECTED_TARGET_MIGRATIONS.includes(f)).map((f) => `unaudited migration ${f}`) },
    )
  }
  const exists = await target.query<{ ok: boolean }>(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`)
  if (!exists.rows[0]?.ok) throw new DataCopyError("target_schema_mismatch", "The target has no public.schema_migrations. Run scripts/db/migrate-local.sh first.")
  const { rows } = await target.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM public.schema_migrations ORDER BY version`)
  const problems: string[] = []
  const applied = rows.map((r) => r.version)
  for (const v of EXPECTED_TARGET_MIGRATIONS) if (!applied.includes(v)) problems.push(`not applied: ${v}`)
  for (const v of applied) if (!EXPECTED_TARGET_MIGRATIONS.includes(v)) problems.push(`unexpected migration: ${v}`)
  for (const r of rows) {
    if (!EXPECTED_TARGET_MIGRATIONS.includes(r.version)) continue
    const file = fs.readFileSync(path.join(migrationsDir, `${r.version}.sql`))
    if (sha256(file) !== r.checksum) problems.push(`checksum differs from database/migrations: ${r.version}`)
  }
  if (problems.length > 0) {
    throw new DataCopyError("target_schema_mismatch", `The target schema version is not the audited 0001-0011 set (${problems.length} problem(s)).`, { details: problems })
  }
  return { migrations: applied, fingerprint: sha256(rows.map((r) => `${r.version}:${r.checksum}`).join("\n")) }
}

/**
 * The copy disables named triggers (ALTER TABLE ... DISABLE TRIGGER), which
 * needs table ownership. That is the migration/owner role's job; the
 * restricted application role must never be used here (and could not).
 */
export async function checkTargetRole(target: Queryable): Promise<{ role: string; superuser: boolean }> {
  const { rows } = await target.query<{ role: string; superuser: boolean; app_member: boolean; not_owner: string[] }>(
    `SELECT current_user AS role,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            current_user = 'cartoona_app' OR EXISTS (
              SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
              WHERE g.rolname = 'cartoona_app' AND u.rolname = current_user) AS app_member,
            array(SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY ($1::text[])
                  AND NOT pg_has_role(current_user, tableowner, 'USAGE') ORDER BY 1) AS not_owner`,
    [ALL_TABLES.map((t) => t.table)],
  )
  const r = rows[0]
  if (r.app_member) {
    throw new DataCopyError("target_role", "The target connection uses the restricted application role (cartoona_app). Use the schema owner / migration role for the copy.")
  }
  if (r.not_owner.length > 0) {
    throw new DataCopyError("target_role", `The target role does not own ${r.not_owner.length} table(s); the copy needs the owner / migration role.`, { details: r.not_owner })
  }
  return { role: r.role, superuser: r.superuser }
}

/** The PostgreSQL server + database a connection really reaches, to refuse source == target behind different URLs. */
export async function databaseIdentity(db: Queryable): Promise<string> {
  let system = "unknown"
  try {
    const s = await db.query<{ id: string }>(`SELECT system_identifier::text AS id FROM pg_control_system()`)
    system = s.rows[0]?.id ?? "unknown"
  } catch {
    // pg_control_system may be restricted; fall back to the data directory-independent pieces below.
  }
  const { rows } = await db.query<{ db: string; oid: string; started: string }>(
    `SELECT current_database() AS db, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid,
            pg_postmaster_start_time()::text AS started`,
  )
  return `${system}/${rows[0].started}/${rows[0].oid}/${rows[0].db}`
}

export type TargetState =
  | { kind: "fresh" }
  | { kind: "run"; run: RunRow; donePhases: Set<string> }

export interface RunRow {
  id: string
  status: "in_progress" | "completed" | "failed_validation"
  source_data_fingerprint: string
  source_schema_fingerprint: string
}

export async function tableCounts(db: Queryable, tables: TableSpec[]): Promise<Record<string, number>> {
  const sql = tables.map((t) => `SELECT '${t.table}' AS t, count(*)::bigint AS n FROM public."${t.table}"`).join(" UNION ALL ")
  const { rows } = await db.query<{ t: string; n: string }>(sql)
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]))
}

/** Is each of these tables in the state a freshly migrated target has (empty, or exactly the 0008 seed)? */
export function nonInitialTables(counts: Record<string, number>, tables: TableSpec[]): string[] {
  return tables
    .filter((t) => counts[t.table] !== (REFERENCE_SEED_COUNTS[t.table] ?? 0))
    .map((t) => `${t.table}: ${counts[t.table]} row(s), expected ${REFERENCE_SEED_COUNTS[t.table] ?? 0}`)
}

/**
 * Classify the target. Supported states only:
 *   fresh  - migrated, never copied into: every domain table empty, the
 *            reference tables holding exactly the 0008 seed counts;
 *   run    - holds this tool's bookkeeping (a completed, resumable or failed run).
 * Anything else (rows the copy did not write, no bookkeeping) is refused.
 */
export async function classifyTarget(target: Queryable): Promise<TargetState> {
  const meta = await target.query<{ ok: boolean }>(`SELECT to_regclass('${META_SCHEMA}.runs') IS NOT NULL AS ok`)
  if (meta.rows[0]?.ok) {
    const runs = await target.query<RunRow>(`SELECT id::text, status, source_data_fingerprint, source_schema_fingerprint FROM ${META_SCHEMA}.runs`)
    if (runs.rows.length === 1) {
      const phases = await target.query<{ phase: string }>(`SELECT phase FROM ${META_SCHEMA}.phases WHERE run_id = $1`, [runs.rows[0].id])
      return { kind: "run", run: runs.rows[0], donePhases: new Set(phases.rows.map((p) => p.phase)) }
    }
    throw new DataCopyError("target_state_unsupported", `The target's ${META_SCHEMA} schema holds ${runs.rows.length} runs; expected exactly one. Recreate the target.`, { exitCode: 3 })
  }
  const counts = await tableCounts(target, ALL_TABLES)
  const dirty = nonInitialTables(counts, ALL_TABLES)
  if (dirty.length > 0) {
    throw new DataCopyError(
      "target_not_empty",
      `The target already contains records that this tool did not write (${dirty.length} table(s)). Copy only into a freshly migrated database.`,
      { exitCode: 3, details: dirty },
    )
  }
  return { kind: "fresh" }
}

import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { withPgClusterLock } from "./pg-cluster-lock"

/**
 * Local-container plumbing for the V0.1.44 data-copy suites (opt-in,
 * CARTOONA_PLAIN_PG=docker). Every database is created in the compose
 * `postgres` service under a unique name and dropped by the caller. Nothing
 * here reads a .env file or can reach a hosted service.
 *
 * The copy tool connects from the host (pg over 127.0.0.1:<published port>)
 * as the container's owner role. Its password is read from the container's
 * own environment at run time and is never printed.
 */

const run = promisify(execFile)
export const root = process.cwd()

// Data-cleanup migrations that assert production row counts (same list as plain-postgres-db).
const SKIPPED_ON_EMPTY_DB = ["20260727121000", "20260727122000", "20260727123000"]

export interface PgEnv {
  container: string
  port: string
  password: string
}

export async function pgEnv(): Promise<PgEnv> {
  const container = (await run("docker", ["compose", "ps", "-q", "postgres"], { cwd: root })).stdout.trim()
  if (!container) throw new Error("compose postgres service is not running: docker compose up -d postgres")
  const port = (await run("docker", ["compose", "port", "postgres", "5432"], { cwd: root })).stdout.trim().split(":").pop() ?? ""
  const password = (await run("docker", ["exec", container, "printenv", "POSTGRES_PASSWORD"])).stdout.trim()
  return { container, port, password }
}

export function ownerUrl(env: PgEnv, db: string, host = "127.0.0.1"): string {
  return `postgresql://cartoona:${env.password}@${host}:${env.port}/${db}`
}

/** psql as the owner inside the container. Returns trimmed stdout; throws with stderr on error. */
export async function psql(env: PgEnv, db: string, sql: string, file?: string): Promise<string> {
  const args = ["exec", "-i", env.container, "psql", "-U", "cartoona", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db, "-c", "SET client_min_messages = warning"]
  if (file) {
    const child = run("docker", [...args, "-f", "-"], { maxBuffer: 64 * 1024 * 1024 })
    child.child.stdin?.end(fs.readFileSync(file))
    return (await child).stdout.trim()
  }
  return (await run("docker", [...args, "-c", sql], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
}

export async function attempt(env: PgEnv, db: string, sql: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    return { ok: true, out: await psql(env, db, sql), err: "" }
  } catch (e) {
    return { ok: false, out: "", err: String((e as { stderr?: string }).stderr ?? e) }
  }
}

export async function createDb(env: PgEnv, db: string, template?: string): Promise<void> {
  await psql(env, "postgres", `create database ${db}${template ? ` template ${template}` : ""}`)
}

export async function dropDbs(env: PgEnv, dbs: string[]): Promise<void> {
  for (const db of dbs) await psql(env, "postgres", `drop database if exists ${db} with (force)`).catch(() => undefined)
}

/** Run a repo script with a minimal environment (psql inside the container). */
export function script(env: PgEnv, file: string, vars: Record<string, string>, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(root, file), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", PSQL: path.join(root, "scripts/db/psql-docker.sh"), CARTOONA_PG_CONTAINER: env.container, ...vars },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }))
  })
}

/** A freshly migrated plain target, through the real runner. */
export async function migrateTarget(env: PgEnv, db: string, migrationsDir?: string): Promise<string> {
  await createDb(env, db)
  const out = await withPgClusterLock(() =>
    script(env, "scripts/db/migrate-local.sh", {
      DATABASE_URL: `postgresql://cartoona@postgres:5432/${db}`,
      ...(migrationsDir ? { CARTOONA_MIGRATIONS_DIR: migrationsDir } : {}),
    }),
  )
  if (out.code !== 0) throw new Error(`migrate failed: ${out.stderr}`)
  return out.stdout
}

/**
 * A Supabase-shaped source: the stub for auth/storage/roles, then the real
 * historical supabase/migrations chain, then (optionally) a fixture.
 */
export async function buildSupabaseSource(env: PgEnv, db: string, fixture?: string): Promise<void> {
  await createDb(env, db)
  await withPgClusterLock(async () => {
    await psql(env, db, "", path.join(root, "tests/helpers/supabase-stub.sql"))
  })
  const dir = path.join(root, "supabase/migrations")
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (SKIPPED_ON_EMPTY_DB.some((p) => f.startsWith(p))) continue
    await psql(env, db, "", path.join(dir, f))
  }
  if (fixture) await psql(env, db, "", fixture)
}

/** count + content checksum of every public table, for before/after comparisons. */
export async function snapshot(env: PgEnv, db: string): Promise<Record<string, string>> {
  const tables = (await psql(env, db, "select tablename from pg_tables where schemaname = 'public' order by 1")).split("\n").filter(Boolean)
  const out: Record<string, string> = {}
  for (const t of tables) {
    out[t] = await psql(env, db, `select count(*) || ':' || md5(coalesce(string_agg(md5(x::text), '' order by md5(x::text)), '')) from public.${t} x`)
  }
  return out
}

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { Pool } from "pg"
import { checkSchemaHead, checkSessionRole } from "@/lib/db/health"
import { dropDbs, migrateTarget, pgEnv, psql, root, type PgEnv } from "../helpers/data-copy-db"

/**
 * V0.1.54: database/ops/create-app-login-role.sql, the production (remote-host)
 * way to create the application's login role, run against a scratch local
 * database (opt-in: CARTOONA_PLAIN_PG=docker). Also proves the role it creates
 * passes the backend's own startup/readiness checks (restricted role + migration head).
 */
const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const run = promisify(execFile)
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const TGT = `ops_${id}`
const ROLE = `cartoona_app_op${id}`
const PW = randomBytes(24).toString("hex")
let env: PgEnv

async function sqlFile(db: string, vars: Record<string, string>, pw: string | undefined) {
  const args = ["exec", "-i", ...(pw === undefined ? [] : ["-e", `CARTOONA_APP_DB_PASSWORD=${pw}`]), env.container, "psql", "-U", "cartoona", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-d", db, "-f", "-"]
  const child = run("docker", args)
  child.child.stdin?.end(fs.readFileSync(path.join(root, "database/ops/create-app-login-role.sql")))
  try {
    const r = await child
    return { code: 0, out: r.stdout.trim(), err: r.stderr }
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string }
    return { code: x.code ?? 1, out: (x.stdout ?? "").trim(), err: x.stderr ?? "" }
  }
}

describe.skipIf(!enabled)("production login-role provisioning SQL (scratch local database)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })
  beforeAll(async () => {
    env = await pgEnv()
    await migrateTarget(env, TGT)
  })
  afterAll(async () => {
    if (!env) return
    await dropDbs(env, [TGT])
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
  })

  it("refuses a missing or weak password and a bad role name, creating nothing", async () => {
    for (const [vars, pw] of [[{ role: ROLE }, undefined], [{ role: ROLE }, "short"], [{ role: "postgres" }, PW], [{ role: "cartoona_app_UP" }, PW]] as const) {
      const r = await sqlFile(TGT, { ...vars }, pw)
      expect(r.code, JSON.stringify(vars)).not.toBe(0)
      expect(r.out + r.err).not.toContain(PW)
    }
    expect(await psql(env, "postgres", `select count(*) from pg_roles where rolname = '${ROLE}'`)).toBe("0")
  })

  it("creates a restricted member of cartoona_app that passes the backend's startup checks; a rerun re-passwords it", async () => {
    const r = await sqlFile(TGT, { role: ROLE }, PW)
    expect(r.code).toBe(0)
    expect(r.out).toBe(`${ROLE}|t|f|t|t`)
    expect(r.out + r.err).not.toContain(PW)
    const pool = new Pool({ connectionString: `postgresql://${ROLE}:${PW}@127.0.0.1:${env.port}/${TGT}`, max: 1 })
    try {
      expect(await checkSessionRole(pool)).toEqual({ ok: true })
      expect(await checkSchemaHead(pool)).toEqual({ ok: true })
    } finally {
      await pool.end()
    }
    const PW2 = randomBytes(24).toString("hex")
    expect((await sqlFile(TGT, { role: ROLE }, PW2)).code).toBe(0)
    const again = new Pool({ connectionString: `postgresql://${ROLE}:${PW2}@127.0.0.1:${env.port}/${TGT}`, max: 1 })
    try {
      expect((await again.query("select 1 as ok")).rows[0].ok).toBe(1)
    } finally {
      await again.end()
    }
  })

  it("an owner connection fails the same checks (the gate that stops a wrong DATABASE_URL)", async () => {
    const owner = new Pool({ connectionString: `postgresql://cartoona:${env.password}@127.0.0.1:${env.port}/${TGT}`, max: 1 })
    try {
      const r = await checkSessionRole(owner)
      expect(r.ok).toBe(false)
    } finally {
      await owner.end()
    }
  })
})

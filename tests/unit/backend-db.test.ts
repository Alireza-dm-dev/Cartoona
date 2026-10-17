import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest"
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import path from "node:path"
import { withPgClusterLock } from "../helpers/pg-cluster-lock"
import { buildBackendApp } from "@/backend/src/app"
import { getPool } from "@/lib/db/pool"
import { runQuery } from "@/lib/db/query"
import { DbError } from "@/lib/db/errors"
import { setLogSink } from "@/lib/observability/logger"

/**
 * REAL-SQL tests for the V0.1.40 backend (opt-in: CARTOONA_PLAIN_PG=docker,
 * compose `postgres` running). The backend app is built with its DEFAULT
 * dependencies - the shared lib/db pool, from DATABASE_URL - and served with
 * `inject`, against a uniquely named database dal-style `bk_<id>`:
 *
 *  - `cartoona_app_b<id>`: the restricted login role, created by the real
 *    scripts/db/app-login-role.sh (member of cartoona_app);
 *  - `bk_nomember_<id>`: a login role outside cartoona_app;
 *  - `cartoona_app_o<id>`: a cartoona_app member that OWNS a table.
 * The last two must make /ready refuse. Everything is dropped afterwards;
 * nothing reads .env files or reaches a hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const run = promisify(execFile)
const root = process.cwd()
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const DB = `bk_${id}`
const APP_ROLE = `cartoona_app_b${id}`
const NOMEMBER_ROLE = `bk_nomember_${id}`
const OWNER_ROLE = `cartoona_app_o${id}`
const PASSWORD = randomBytes(24).toString("hex")
let container = ""
let port = ""

async function owner(sql: string, db = DB): Promise<string> {
  const { stdout } = await run("docker", [
    "exec", "-i", container, "psql", "-U", "cartoona", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db,
    "-c", "SET client_min_messages = warning", "-c", sql,
  ])
  return stdout.trim()
}

function script(file: string, env: Record<string, string>, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(root, file), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", PSQL: path.join(root, "scripts/db/psql-docker.sh"), CARTOONA_PG_CONTAINER: container, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }))
  })
}

const urlFor = (role: string) => `postgresql://${role}:${PASSWORD}@127.0.0.1:${port}/${DB}`

/** Build the backend with its real, default dependencies, connected as `role`. */
function backendAs(urlOrRole: string) {
  vi.stubEnv("DATABASE_URL", urlOrRole.startsWith("postgresql://") ? urlOrRole : urlFor(urlOrRole))
  return buildBackendApp()
}

describe.skipIf(!enabled)("backend against real PostgreSQL (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 60_000 })
  let restoreSink: () => void = () => {}

  beforeAll(async () => {
    restoreSink = setLogSink(() => {})
    container = (await run("docker", ["compose", "ps", "-q", "postgres"], { cwd: root })).stdout.trim()
    if (!container) throw new Error("compose postgres service is not running: docker compose up -d postgres")
    port = (await run("docker", ["compose", "port", "postgres", "5432"], { cwd: root })).stdout.trim().split(":").pop() ?? ""
    await owner(`create database ${DB}`, "postgres")

    const ownerUrl = `postgresql://cartoona@postgres:5432/${DB}`
    const migrated = await withPgClusterLock(() => script("scripts/db/migrate-local.sh", { DATABASE_URL: ownerUrl }))
    expect(migrated.stdout).toMatch(/done - 11 applied/)
    for (const role of [APP_ROLE, OWNER_ROLE]) {
      const r = await script("scripts/db/app-login-role.sh", { DATABASE_URL: ownerUrl, CARTOONA_APP_DB_PASSWORD: PASSWORD }, [role])
      expect(r.code).toBe(0)
      expect(r.stdout + r.stderr).not.toContain(PASSWORD)
    }
    await owner(`create role ${NOMEMBER_ROLE} login password '${PASSWORD}'`)
    await owner(`grant select on public.creation_pricing to ${NOMEMBER_ROLE}`)
    await owner(`create table public.bk_owned (x int); alter table public.bk_owned owner to ${OWNER_ROLE}`)
  }, 180_000)

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    restoreSink()
    if (!container) return
    await owner(`drop database if exists ${DB} with (force)`, "postgres")
    for (const role of [APP_ROLE, OWNER_ROLE, NOMEMBER_ROLE]) await owner(`drop role if exists ${role}`, "postgres")
  })

  it("restricted login: /health 200, /ready 200, /v1/creation-pricing 200 from PostgreSQL", async () => {
    const app = backendAs(APP_ROLE)
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" })

      const ready = await app.inject({ method: "GET", url: "/ready" })
      expect(ready.statusCode).toBe(200)
      expect(ready.json()).toEqual({ status: "ready" })

      const pricing = await app.inject({ method: "GET", url: "/v1/creation-pricing" })
      expect(pricing.statusCode).toBe(200)
      const expected = Object.fromEntries(
        (await owner("select pricing_key||'='||candy_cost from public.creation_pricing where is_active order by 1"))
          .split("\n").map((l) => { const [k, v] = l.split("="); return [k, Number(v)] }),
      )
      expect(pricing.json()).toEqual({ prices: expected })
      expect(Object.keys(expected)).toHaveLength(9)
      expect(pricing.headers["cache-control"]).toBe("public, s-maxage=60, stale-while-revalidate=300")

      // The pool really is the restricted login role.
      const [who] = await runQuery<{ u: string; s: boolean }>(getPool(), "SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s")
      expect(who).toEqual({ u: APP_ROLE, s: false })
    } finally {
      await app.close()
    }
  })

  it("a catalog change in PostgreSQL is what the endpoint serves", async () => {
    await owner("update public.creation_pricing set candy_cost = 13 where pricing_key = 'image.default'")
    const app = backendAs(APP_ROLE)
    try {
      const pricing = await app.inject({ method: "GET", url: "/v1/creation-pricing" })
      expect(pricing.json().prices["image.default"]).toBe(13)
    } finally {
      await app.close()
      await owner("update public.creation_pricing set candy_cost = 12 where pricing_key = 'image.default'")
    }
  })

  it.each([
    ["a login role outside cartoona_app", () => NOMEMBER_ROLE],
    ["a cartoona_app member that owns a table", () => OWNER_ROLE],
  ])("/ready refuses %s (503, no detail)", async (_label, role) => {
    const app = backendAs(role())
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" })
      expect(ready.statusCode).toBe(503)
      expect(ready.json()).toEqual({ status: "unavailable" })
    } finally {
      await app.close()
    }
  })

  it("unreachable database: /health 200, /ready 503, pricing 503 with the route's body", async () => {
    const app = backendAs(`postgresql://${APP_ROLE}:${PASSWORD}@127.0.0.1:1/${DB}`)
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200)
      const ready = await app.inject({ method: "GET", url: "/ready" })
      expect(ready.statusCode).toBe(503)
      const pricing = await app.inject({ method: "GET", url: "/v1/creation-pricing" })
      expect(pricing.statusCode).toBe(503)
      expect(pricing.json()).toEqual({ error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" })
      expect(ready.body + pricing.body).not.toContain(PASSWORD)
    } finally {
      await app.close()
    }
  })

  describe("the backend's database role (through the backend's own pool)", () => {
    let close: () => Promise<void> = async () => {}
    beforeAll(async () => {
      const app = backendAs(APP_ROLE)
      await app.ready()
      close = () => app.close()
    })
    afterAll(async () => close())

    it.each([
      "users", "parent_profiles", "creation_pricing", "parent_welcome_credits", "candy_wallets", "orders", "order_status_history",
    ])("can SELECT %s", async (table) => {
      await expect(runQuery(getPool(), `SELECT count(*) FROM public.${table}`)).resolves.toBeDefined()
    })

    it.each([
      ["CREATE TABLE", "CREATE TABLE public.bk_x (x int)"],
      ["DROP TABLE", "DROP TABLE public.orders"],
      ["ALTER TABLE", "ALTER TABLE public.orders ADD COLUMN bk int"],
      ["read schema_migrations", "SELECT * FROM public.schema_migrations"],
      ["INSERT", "INSERT INTO public.creation_pricing (pricing_key, candy_cost) VALUES ('x', 1)"],
      ["UPDATE", "UPDATE public.candy_wallets SET balance = 1000"],
      ["DELETE", "DELETE FROM public.order_status_history"],
      ["read an ungranted table", "SELECT * FROM public.candy_transactions"],
      ["execute a trusted write function", "SELECT public.create_parent_request_trusted(NULL::uuid, NULL::uuid, NULL::text, NULL::text)"],
      ["disable triggers", "ALTER TABLE public.order_status_history DISABLE TRIGGER ALL"],
      ["change replication role", "SET session_replication_role = replica"],
      ["create a role", "CREATE ROLE bk_evil"],
      ["grant itself more", "GRANT INSERT ON public.candy_transactions TO CURRENT_USER"],
    ])("cannot %s", async (_label, sql) => {
      const error = await runQuery(getPool(), sql).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DbError)
      expect((error as DbError).sqlState).toBe("42501")
    })
  })
})

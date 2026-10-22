import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest"
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import net from "node:net"
import { promisify } from "node:util"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { GET } from "@/app/api/creation-pricing/route"
import { withPgClusterLock } from "../helpers/pg-cluster-lock"
import { setLogSink } from "@/lib/observability/logger"

/**
 * End-to-end proof of the V0.1.41 cutover, opt-in (CARTOONA_PLAIN_PG=docker):
 *
 *   Next route handler (GET) -> native fetch -> REAL Fastify on a loopback port
 *     -> REAL lib/db pool as a restricted login role -> PostgreSQL
 *
 * The database is a scratch `cp_<id>` built by the real runner (0001-0009) with
 * a script-provisioned login role. A price changed ONLY there (owner session,
 * `docker exec`) must be what the route returns - which a Supabase read or a
 * hard-coded fallback could not do. Every fetch the route makes is recorded and
 * must go to the backend, nowhere else. Nothing reads .env files or reaches a
 * hosted service; the database and role are dropped afterwards.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const run = promisify(execFile)
const root = process.cwd()
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const DB = `cp_${id}`
const ROLE = `cartoona_app_c${id}`
const PASSWORD = randomBytes(24).toString("hex")
const PUBLIC_503 = { error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" }
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

const dbPrices = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await owner("select pricing_key||'='||candy_cost from public.creation_pricing where is_active order by 1"))
      .split("\n").map((l) => { const [k, v] = l.split("="); return [k, Number(v)] }),
  )

interface Recorded { url: string; sentRequestId: string | null; backendRequestId: string | null; status: number | null }
let recorded: Recorded[] = []
const realFetch = globalThis.fetch

/** Records every fetch the route makes, then performs it for real. */
function recordFetch() {
  recorded = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry: Recorded = {
      url: String(input),
      sentRequestId: new Headers(init?.headers).get("x-request-id"),
      backendRequestId: null,
      status: null,
    }
    recorded.push(entry)
    const response = await realFetch(input, init)
    entry.status = response.status
    entry.backendRequestId = response.headers.get("x-request-id")
    return response
  })
}

let app: FastifyInstance | null = null
/** A real Fastify listening on 127.0.0.1:<ephemeral>, using the default (real) pool as `url`. */
async function startBackend(databaseUrl: string): Promise<string> {
  vi.stubEnv("DATABASE_URL", databaseUrl)
  app = buildBackendApp()
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address() as net.AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  vi.stubEnv("BACKEND_INTERNAL_URL", base)
  return base
}

const callRoute = (headers: Record<string, string> = {}) =>
  GET(new Request("http://localhost:3000/api/creation-pricing", { headers }))

describe.skipIf(!enabled)("creation pricing cutover: Next -> Fastify -> PostgreSQL (local Docker PostgreSQL 17)", () => {
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
    expect(migrated.stdout).toMatch(/done - 13 applied/)
    const login = await script("scripts/db/app-login-role.sh", { DATABASE_URL: ownerUrl, CARTOONA_APP_DB_PASSWORD: PASSWORD }, [ROLE])
    expect(login.code).toBe(0)
  }, 180_000)

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await app?.close()
    app = null
  })

  afterAll(async () => {
    restoreSink()
    if (!container) return
    await owner(`drop database if exists ${DB} with (force)`, "postgres")
    await owner(`drop role if exists ${ROLE}`, "postgres")
  })

  const restrictedUrl = () => `postgresql://${ROLE}:${PASSWORD}@127.0.0.1:${port}/${DB}`

  it("returns the catalog stored in PostgreSQL, through Fastify, and only talks to the backend", async () => {
    await startBackend(restrictedUrl())
    recordFetch()
    const res = await callRoute()
    expect(res.status).toBe(200)
    const expected = await dbPrices()
    expect(Object.keys(expected)).toHaveLength(9)
    expect(await res.json()).toEqual({ prices: expected })
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")

    // Exactly one attempt, to the backend's /v1/creation-pricing, and nothing else.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/creation-pricing$/)
    expect(recorded.some((r) => /supabase/i.test(r.url))).toBe(false)
  })

  it("a price changed ONLY in local PostgreSQL is what the route returns (then restored)", async () => {
    await startBackend(restrictedUrl())
    recordFetch()
    const before = (await (await callRoute()).json()).prices["image.default"]
    expect(before).toBe(12)

    await owner("update public.creation_pricing set candy_cost = 777 where pricing_key = 'image.default'")
    try {
      const changed = await (await callRoute()).json()
      expect(changed.prices["image.default"]).toBe(777)
      expect(changed.prices["video.short"]).toBe(40) // untouched rows are unchanged
    } finally {
      await owner("update public.creation_pricing set candy_cost = 12 where pricing_key = 'image.default'")
    }
    expect((await (await callRoute()).json()).prices["image.default"]).toBe(12)
    expect(await owner("select candy_cost from public.creation_pricing where pricing_key = 'image.default'")).toBe("12")
  })

  it("deactivating a price in PostgreSQL removes it from the route; an empty catalog is the public 503", async () => {
    await startBackend(restrictedUrl())
    recordFetch()
    await owner("update public.creation_pricing set is_active = false where pricing_key = 'video.long'")
    try {
      expect(Object.keys((await (await callRoute()).json()).prices)).not.toContain("video.long")
      await owner("update public.creation_pricing set is_active = false")
      const res = await callRoute()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual(PUBLIC_503)
    } finally {
      await owner("update public.creation_pricing set is_active = true")
    }
    expect((await callRoute()).status).toBe(200)
  })

  it("the inbound request id travels Next -> Fastify -> back, one id for one logical request", async () => {
    await startBackend(restrictedUrl())
    recordFetch()
    const rid = "cutover-test-0123456789abcdef"
    const res = await callRoute({ "x-request-id": rid })
    expect(res.headers.get("x-request-id")).toBe(rid)
    expect(recorded[0]).toMatchObject({ sentRequestId: rid, backendRequestId: rid, status: 200 })
  })

  it("the backend's database being unreachable -> public 503 (no Supabase, no fallback)", async () => {
    await startBackend(`postgresql://${ROLE}:${PASSWORD}@127.0.0.1:1/${DB}`)
    recordFetch()
    const res = await callRoute()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(PUBLIC_503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(recorded).toHaveLength(1)
    expect(recorded.every((r) => r.url.includes("/v1/creation-pricing") && !/supabase/i.test(r.url))).toBe(true)
  })

  it("the backend stopped -> public 503 within the bound, no leak", async () => {
    const base = await startBackend(restrictedUrl())
    await app!.close()
    app = null
    recordFetch()
    const started = performance.now()
    const res = await callRoute()
    const elapsed = performance.now() - started
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(PUBLIC_503)
    expect(elapsed).toBeLessThan(3500)
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(base)
    expect(recorded).toHaveLength(1)
  })

  it("a backend that accepts and never answers -> public 503 at the configured timeout, not later", async () => {
    const sockets: net.Socket[] = []
    const hung = net.createServer((socket) => sockets.push(socket)).listen(0, "127.0.0.1")
    await new Promise<void>((resolve) => hung.once("listening", resolve))
    try {
      vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${(hung.address() as net.AddressInfo).port}`)
      vi.stubEnv("BACKEND_REQUEST_TIMEOUT_MS", "600")
      recordFetch()
      const started = performance.now()
      const res = await callRoute()
      const elapsed = performance.now() - started
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual(PUBLIC_503)
      expect(elapsed).toBeGreaterThanOrEqual(550)
      expect(elapsed).toBeLessThan(1500)
      expect(recorded).toHaveLength(1)
    } finally {
      sockets.forEach((s) => s.destroy())
      hung.close()
    }
  })
})

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import type net from "node:net"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { buildBackendApp } from "@/backend/src/app"
import { closePool } from "@/lib/db/pool"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, type PgEnv } from "../helpers/data-copy-db"

/**
 * V0.1.54 concurrency / pool-saturation rehearsal (opt-in, slow):
 *
 *   CARTOONA_PLAIN_PG=docker CARTOONA_LOAD_REHEARSAL=1 \
 *   [CARTOONA_LOAD_REPORT=/path/report.json] npx vitest run tests/unit/backend-load-db.test.ts
 *
 * A copied database (synthetic scale source -> V0.1.44 copy -> restricted
 * cartoona_app login), the real Fastify app listening on loopback, signed v2
 * assertions, many parents reading /v1/parent/orders at 20 and 50 concurrent
 * clients with the default pool (5) and a larger one (20). Reports requests/s,
 * p50/p95/max latency, status counts and the pool's waiting peak. Not a gate on
 * speed: it asserts correctness under load (only 200s, or the documented 503
 * when the pool cannot hand out a connection in time) and that the backend still
 * answers /ready afterwards. Local only; nothing contacts a hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker" && process.env.CARTOONA_LOAD_REHEARSAL === "1"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `bls_${id}`
const TGT = `blt_${id}`
const ROLE = `cartoona_app_ld${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")

let env: PgEnv
const report: Record<string, unknown> = {}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

const sign = (subject: string) =>
  signAssertion({
    identity: toVerifiedIdentity({ provider: "supabase", subject }),
    authenticatedAt: Date.now() - 86_400_000,
    requestId: "load-rehearsal-01",
    method: "GET",
    path: "/v1/parent/orders",
    secret: Buffer.from(AUTH_SECRET, "hex"),
  })

describe.skipIf(!enabled)("V0.1.54 backend under concurrent load (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 })
  let subjects: string[] = []

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, path.join(root, "tests/fixtures/data-copy/synthetic-scale.sql"))
    await migrateTarget(env, TGT)
    const copied = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    expect(copied.outcome).toBe("completed")
    expect((await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${TGT}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])).code).toBe(0)
    // Live (not soft-deleted) parents that have orders.
    subjects = (await psql(env, TGT, "select i.provider_subject from public.user_identities i join public.users u on u.id = i.user_id join public.parent_profiles p on p.user_id = u.id where u.role = 'parent' and u.deleted_at is null order by 1 limit 400")).split("\n").filter(Boolean)
    expect(subjects.length).toBeGreaterThan(100)
  })

  afterAll(async () => {
    await closePool()
    vi.unstubAllEnvs()
    if (!env) return
    await dropDbs(env, [SRC, TGT])
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
    const out = process.env.CARTOONA_LOAD_REPORT
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2))
  })

  for (const [clients, poolMax] of [[20, 5], [50, 5], [50, 20]] as const) {
    it(`${clients} concurrent parents, pool max ${poolMax}`, async () => {
      vi.stubEnv("DATABASE_URL", `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${TGT}`)
      vi.stubEnv("DB_POOL_MAX", String(poolMax))
      vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
      await closePool() // a fresh pool with this size
      const app: FastifyInstance = buildBackendApp()
      await app.listen({ host: "127.0.0.1", port: 0 })
      const url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`
      try {
        expect((await fetch(`${url}/ready`)).status).toBe(200)
        const statuses: Record<string, number> = {}
        const lat: number[] = []
        const perClient = 40
        const t0 = Date.now()
        await Promise.all(Array.from({ length: clients }, async (_, c) => {
          for (let i = 0; i < perClient; i++) {
            const subject = subjects[(c * 7 + i * 13) % subjects.length]
            const s = performance.now()
            const res = await fetch(`${url}/v1/parent/orders`, { headers: { "x-cartoona-internal-auth": sign(subject) } })
            await res.arrayBuffer()
            lat.push(performance.now() - s)
            statuses[res.status] = (statuses[res.status] ?? 0) + 1
          }
        }))
        const wall = Date.now() - t0
        const total = clients * perClient
        report[`${clients}c_pool${poolMax}`] = {
          requests: total, wallMs: wall, rps: Math.round((total / wall) * 1000), statuses,
          latencyMs: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), max: Math.round(Math.max(...lat)) },
        }
        // Correct under load: only success, or the documented transient 503 - never a 500 or a wrong identity.
        expect(Object.keys(statuses).every((s) => s === "200" || s === "503")).toBe(true)
        expect(statuses["200"] ?? 0).toBeGreaterThan(total * 0.95)
        expect((await fetch(`${url}/ready`)).status).toBe(200) // recovered / still healthy
      } finally {
        await app.close()
        vi.unstubAllEnvs()
      }
    })
  }
})

import { describe, it, expect, vi, afterAll, beforeAll } from "vitest"

const jar = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }))
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => jar.cookies, set: () => {} }),
}))

import { NextRequest } from "next/server"
import { middleware } from "@/middleware"
import { getPublicHeaderAccount } from "@/lib/auth/public-header-account"
import { GET as backendMe } from "@/app/api/auth/backend-me/route"
import { buildBackendApp } from "@/backend/src/app"
import type { Queryable } from "@/lib/db/types"
import { setLogSink } from "@/lib/observability/logger"
import { startStubAuth, type StubAuth } from "../helpers/stub-supabase-auth"
import type { AddressInfo } from "node:net"

/**
 * Local round-trip and latency report for the auth paths (V0.1.43), opt-in:
 * CARTOONA_MEASURE_AUTH_TIMINGS=1. Everything is local: a stub provider on
 * loopback, a real Fastify on loopback with an in-memory identity table.
 * Numbers are for comparing paths and counting round trips, NOT production
 * estimates. Results go to stderr.
 */

const enabled = process.env.CARTOONA_MEASURE_AUTH_TIMINGS === "1"
const USER = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"
const SECRET = "ab".repeat(32)

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b)
  return `median ${s[Math.floor(s.length / 2)].toFixed(2)} ms, p90 ${s[Math.floor(s.length * 0.9)].toFixed(2)} ms (n=${s.length})`
}

async function measure(n: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < 10; i++) await fn()
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await fn()
    out.push(performance.now() - t)
  }
  return out
}

describe.skipIf(!enabled)("auth path round trips and local timings", () => {
  vi.setConfig({ testTimeout: 120_000 })
  let stub: StubAuth
  let backend: ReturnType<typeof buildBackendApp>
  const lines: string[] = []

  beforeAll(async () => {
    setLogSink(() => {})
    stub = await startStubAuth({ userId: USER })
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", stub.url)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon")
    vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", SECRET)
    const db: Queryable = {
      async query() {
        return { rows: [{ user_id: USER, role: "parent", deleted: false, sessions_not_before_ms: null }], rowCount: 1, command: "SELECT", oid: 0, fields: [] } as never
      },
    }
    backend = buildBackendApp({ db: () => db, closeDb: async () => {} })
    await backend.listen({ host: "127.0.0.1", port: 0 })
    vi.stubEnv("BACKEND_INTERNAL_URL", `http://127.0.0.1:${(backend.server.address() as AddressInfo).port}`)
  })

  afterAll(async () => {
    await backend?.close()
    await stub?.close()
    vi.unstubAllEnvs()
    process.stderr.write(`[auth timings, local stub provider + loopback Fastify]\n${lines.map((l) => `  ${l}`).join("\n")}\n`)
  })

  const countDuring = async (fn: () => Promise<unknown>) => {
    const before = stub.requests.length
    await fn()
    return stub.requests.slice(before).map((r) => `${r.method} ${r.path}`)
  }

  it("public header (valid session)", async () => {
    const cookie = stub.cookie()
    jar.cookies = [cookie]
    const calls = await countDuring(() => getPublicHeaderAccount())
    lines.push(`public header: ${calls.length} sequential provider calls [${calls.join(", ")}]; ${stats(await measure(200, () => getPublicHeaderAccount()))}`)
    expect(calls).toEqual(["GET /auth/v1/user", "GET /rest/v1/users", "GET /rest/v1/parent_profiles"])
  })

  it("protected middleware (valid session, /dashboard)", async () => {
    const cookie = stub.cookie()
    const req = () => new NextRequest("http://localhost/dashboard", { headers: { cookie: `${cookie.name}=${cookie.value}` } })
    const calls = await countDuring(() => middleware(req()))
    const res = await middleware(req())
    expect(res.status).toBe(200)
    lines.push(`middleware /dashboard: ${calls.length} sequential provider calls [${calls.join(", ")}] (was 3: + the lifetime RPC); ${stats(await measure(200, () => middleware(req())))}`)
    expect(calls).toEqual(["GET /auth/v1/user", "GET /rest/v1/users"])
  })

  it("/api/auth/backend-me (valid session)", async () => {
    jar.cookies = [stub.cookie()]
    const call = () => backendMe(new Request("http://localhost/api/auth/backend-me"))
    const calls = await countDuring(call)
    expect((await call()).status).toBe(200)
    lines.push(`/api/auth/backend-me: ${calls.length} provider call [${calls.join(", ")}] + 1 backend call + 1 identity query; ${stats(await measure(200, call))}`)
    expect(calls).toEqual(["GET /auth/v1/user"])
  })

  it("outage bounds (provider refresh hangs)", async () => {
    stub.options.refreshMode = "hang"
    const expired = stub.cookie({ expired: true })
    jar.cookies = [expired]
    const t1 = performance.now()
    expect(await getPublicHeaderAccount()).toBeNull()
    const header = performance.now() - t1
    const t2 = performance.now()
    const mw = await middleware(new NextRequest("http://localhost/dashboard", { headers: { cookie: `${expired.name}=${expired.value}` } }))
    const mwMs = performance.now() - t2
    jar.cookies = [stub.cookie({ expired: true })]
    const t3 = performance.now()
    const bff = await backendMe(new Request("http://localhost/api/auth/backend-me"))
    const bffMs = performance.now() - t3
    lines.push(`outage: public header ${(header / 1000).toFixed(2)} s -> anonymous; middleware ${(mwMs / 1000).toFixed(2)} s -> ${mw.status}; backend-me ${(bffMs / 1000).toFixed(2)} s -> ${bff.status}`)
    expect(mw.status).toBe(503)
    expect(bff.status).toBe(503)
    stub.options.refreshMode = "ok"
  })
})

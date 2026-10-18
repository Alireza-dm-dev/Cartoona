import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, type PgEnv } from "../helpers/data-copy-db"

/**
 * V0.1.44 data-copy timings on a scaled synthetic source (opt-in, slow):
 *
 *   CARTOONA_PLAIN_PG=docker CARTOONA_DATA_COPY_PERF=1 npx vitest run tests/unit/data-copy-perf-db.test.ts
 *
 * 1,000 users / ~10,000 orders plus representative ledger, history and media
 * rows (tests/fixtures/data-copy/synthetic-scale.sql), copied into a fresh
 * plain target in the local container. Prints total copy time, validation
 * time, the slowest phase and table, and peak RSS of this process (which runs
 * the tool). Not a benchmark gate: it only asserts that the copy completes and
 * validates.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker" && process.env.CARTOONA_DATA_COPY_PERF === "1"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `dps_${id}`
const TGT = `dpt_${id}`
let env: PgEnv

describe.skipIf(!enabled)("V0.1.44 data copy at scale (1k users, 10k orders)", () => {
  vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, path.join(root, "tests/fixtures/data-copy/synthetic-scale.sql"))
    await migrateTarget(env, TGT)
  })

  afterAll(async () => {
    if (env) await dropDbs(env, [SRC, TGT])
  })

  it("copies and validates the scaled fixture; reports timings", async () => {
    const counts = await psql(env, SRC, `select (select count(*) from public.users) || ' users, ' || (select count(*) from public.orders) || ' orders, ' ||
      (select count(*) from public.candy_transactions) || ' ledger, ' || (select count(*) from public.order_status_history) || ' history, ' ||
      (select count(*) from public.media_assets) || ' media, ' || (select count(*) from public.audit_logs) || ' audit'`)
    let peak = process.memoryUsage().rss
    const baseline = peak
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20)
    const t0 = Date.now()
    let result
    try {
      result = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    } finally {
      clearInterval(sampler)
    }
    const wall = Date.now() - t0
    expect(result.outcome).toBe("completed")
    expect(result.manifest.validation.preservation?.mismatches).toEqual([])

    const tables = result.manifest.phases.flatMap((p) => p.tables).sort((a, b) => b.durationMs - a.durationMs)
    const phases = [...result.manifest.phases].sort((a, b) => b.durationMs - a.durationMs)
    const rows = tables.reduce((n, t) => n + t.rows, 0)
    const report = {
      source: counts,
      rowsCopied: rows,
      wallMs: wall,
      timingsMs: result.manifest.timingsMs,
      slowestPhase: `${phases[0].name} ${phases[0].durationMs} ms`,
      slowestTables: tables.slice(0, 4).map((t) => `${t.table} ${t.rows} rows ${t.durationMs} ms`),
      phases: result.manifest.phases.map((p) => `${p.name} ${p.durationMs} ms`),
      rssMb: { baseline: Math.round(baseline / 1048576), peak: Math.round(peak / 1048576) },
    }
    console.log(`[data-copy perf] ${JSON.stringify(report, null, 2)}`)
    // Second run on the completed target: verify-only cost.
    const t1 = Date.now()
    const again = await runDataCopy({ sourceUrl: ownerUrl(env, SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    expect(again.outcome).toBe("verified_noop")
    console.log(`[data-copy perf] verified no-op rerun: ${Date.now() - t1} ms`)
  })
})

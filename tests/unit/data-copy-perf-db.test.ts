import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { runDataCopy } from "@/scripts/db/data-copy/copy"
import { buildSupabaseSource, createDb, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, type PgEnv } from "../helpers/data-copy-db"

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
 *
 * V0.1.54 knobs (all optional):
 *   CARTOONA_DATA_COPY_PERF_PARENTS=9990   parents (+10 admins): 10,000 users, ~100,000 orders
 *   CARTOONA_DATA_COPY_PERF_VIA_DUMP=1     mechanics rehearsal of the real export path on the
 *                                          SYNTHETIC source: pg_dump -Fc -> pg_restore into a
 *                                          staging database -> copy FROM THE STAGING DB. This is
 *                                          NOT a production export; it proves the tooling path only.
 * The printed report is counts, checksums, timings and memory only - no row values.
 */
const exec = promisify(execFile)

const enabled = process.env.CARTOONA_PLAIN_PG === "docker" && process.env.CARTOONA_DATA_COPY_PERF === "1"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const PARENTS = Number(process.env.CARTOONA_DATA_COPY_PERF_PARENTS ?? "990")
const VIA_DUMP = process.env.CARTOONA_DATA_COPY_PERF_VIA_DUMP === "1"
const SRC = `dps_${id}`
const STAGE = `dpg_${id}`
const TGT = `dpt_${id}`
let env: PgEnv
const extra: Record<string, unknown> = {}
const REPORT = process.env.CARTOONA_DATA_COPY_PERF_REPORT // optional JSON report path (vitest hides console output)

describe.skipIf(!enabled)("V0.1.44/54 data copy at scale", () => {
  vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 })

  beforeAll(async () => {
    env = await pgEnv()
    const fixture = path.join(os.tmpdir(), `synthetic-scale-${id}.sql`)
    fs.writeFileSync(fixture, fs.readFileSync(path.join(root, "tests/fixtures/data-copy/synthetic-scale.sql"), "utf8").replace("synth.parents = '990'", `synth.parents = '${PARENTS}'`))
    try {
      await buildSupabaseSource(env, SRC, fixture)
    } finally {
      fs.rmSync(fixture, { force: true })
    }
    if (VIA_DUMP) {
      const t = Date.now()
      const dump = `/tmp/${SRC}.dump`
      await exec("docker", ["exec", env.container, "pg_dump", "-U", "cartoona", "-Fc", "--no-owner", "--no-privileges", "-f", dump, SRC], { maxBuffer: 64 * 1024 * 1024 })
      const dumpedMb = Number((await exec("docker", ["exec", env.container, "sh", "-c", `stat -c %s ${dump}`])).stdout.trim()) / 1048576
      await createDb(env, STAGE)
      // pg_restore into an EMPTY database; role/extension errors surface as a non-zero exit (nothing is ignored).
      await exec("docker", ["exec", env.container, "pg_restore", "-U", "cartoona", "--no-owner", "--no-privileges", "--exit-on-error", "-d", STAGE, dump], { maxBuffer: 64 * 1024 * 1024 })
      await exec("docker", ["exec", env.container, "rm", "-f", dump])
      extra.dumpRestore = { ms: Date.now() - t, dumpMiB: Number(dumpedMb.toFixed(1)) }
      console.log(`[data-copy perf] dump+restore mechanics: ${Date.now() - t} ms, dump ${dumpedMb.toFixed(1)} MiB`)
    }
    await migrateTarget(env, TGT)
  })

  afterAll(async () => {
    if (env) await dropDbs(env, [SRC, TGT, STAGE])
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
      result = await runDataCopy({ sourceUrl: ownerUrl(env, VIA_DUMP ? STAGE : SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    } finally {
      clearInterval(sampler)
    }
    const wall = Date.now() - t0
    expect(result.outcome).toBe("completed")
    expect(result.manifest.validation.preservation?.mismatches).toEqual([])

    const tables = result.manifest.phases.flatMap((p) => p.tables).sort((a, b) => b.durationMs - a.durationMs)
    const phases = [...result.manifest.phases].sort((a, b) => b.durationMs - a.durationMs)
    const rows = tables.reduce((n, t) => n + t.rows, 0)
    // Reconciliation (counts + content checksums per table, from the manifest; no row values).
    const reconciliation = {
      preservationMismatches: result.manifest.validation.preservation?.mismatches.length ?? null,
      tablesCompared: result.manifest.validation.preservation?.tables ?? null,
      sourceChecks: result.manifest.validation.source,
      targetChecks: result.manifest.validation.target,
      perTable: tables.map((t) => `${t.table} ${t.rows} ${t.checksum.slice(0, 12)}`).sort(),
    }
    const report = {
      parents: PARENTS,
      viaDump: VIA_DUMP,
      reconciliation,
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
    Object.assign(extra, report)
    // Second run on the completed target: verify-only cost.
    const t1 = Date.now()
    const again = await runDataCopy({ sourceUrl: ownerUrl(env, VIA_DUMP ? STAGE : SRC), targetUrl: ownerUrl(env, TGT), migrationsDir: path.join(root, "database/migrations"), env: {} })
    expect(again.outcome).toBe("verified_noop")
    console.log(`[data-copy perf] verified no-op rerun: ${Date.now() - t1} ms`)
    extra.verifiedNoopRerunMs = Date.now() - t1
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(extra, null, 2))
  })
})

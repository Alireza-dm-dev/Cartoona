import { describe, expect, it } from "vitest"
import fs from "node:fs"
import { DATA_TABLES, classifyImportState, compareMigrations, countDifferences, interpretFreezeProbe, isHostedSupabase, isLoopback, targetFingerprint } from "../../scripts/ops/cutover-check-core.mjs"

describe("cutover check (V0.1.55)", () => {
  it("fingerprints a target without exposing it, ignoring credentials", () => {
    const a = targetFingerprint("postgresql://owner:pw1@Db.Internal:5432/cartoona")
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(targetFingerprint("postgresql://other:pw2@db.internal/cartoona")).toBe(a)
    expect(targetFingerprint("postgresql://owner:pw1@db.internal:5432/cartoona_staging")).not.toBe(a)
    expect(a).not.toContain("internal")
  })

  it("recognises hosted Supabase and loopback hosts", () => {
    expect(isHostedSupabase("postgresql://p:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres")).toBe(true)
    expect(isHostedSupabase("postgresql://p:x@aws-0-eu.pooler.supabase.com:6543/postgres")).toBe(true)
    expect(isHostedSupabase("postgresql://p:x@db.internal/cartoona")).toBe(false)
    expect(isLoopback("postgresql://p:x@127.0.0.1:5433/c")).toBe(true)
    expect(isLoopback("postgresql://p:x@db.internal/c")).toBe(false)
  })

  it("compares applied migrations with files: missing, extra and edited", () => {
    const files = [{ version: "0001_a", checksum: "x" }, { version: "0002_b", checksum: "y" }]
    expect(compareMigrations([{ version: "0001_a", checksum: "x" }, { version: "0002_b", checksum: "y" }], files).ok).toBe(true)
    expect(compareMigrations([{ version: "0001_a", checksum: "x" }], files)).toMatchObject({ ok: false, missing: ["0002_b"] })
    expect(compareMigrations([{ version: "0001_a", checksum: "x" }, { version: "0002_b", checksum: "y" }, { version: "0003_c", checksum: "z" }], files)).toMatchObject({ ok: false, extra: ["0003_c"] })
    expect(compareMigrations([{ version: "0001_a", checksum: "x" }, { version: "0002_b", checksum: "EDITED" }], files)).toMatchObject({ ok: false, changed: ["0002_b"] })
  })

  it("classifies the import state and lists count differences", () => {
    expect(classifyImportState({})).toBe("empty")
    expect(classifyImportState({ users: 0, orders: 0 })).toBe("empty")
    expect(classifyImportState({ users: 1 })).toBe("populated")
    const source = Object.fromEntries(DATA_TABLES.map((t) => [t, 5]))
    expect(countDifferences(source, { ...source })).toEqual([])
    expect(countDifferences(source, { ...source, orders: 4 })).toEqual([{ table: "orders", source: 5, target: 4 }])
    expect(countDifferences(source, { ...source, orders: null })).toHaveLength(1)
  })

  it("interprets the freeze probe", () => {
    expect(interpretFreezeProbe(503, { code: "write_freeze" })).toBe("frozen")
    expect(interpretFreezeProbe(503, { code: "csrf_not_configured" })).toBe("unavailable")
    expect(interpretFreezeProbe(403, { code: "csrf_rejected" })).toBe("not_frozen")
    expect(interpretFreezeProbe(401, null)).toBe("not_frozen")
    expect(interpretFreezeProbe(200, {})).toBe("unknown")
  })

  it("the data tables exist in the migrations and the script is read-only", () => {
    const schema = ["0002_tables.sql", "0003_identity.sql"].map((f) => fs.readFileSync(`database/migrations/${f}`, "utf8")).join("\n")
    for (const t of DATA_TABLES) expect(schema, t).toMatch(new RegExp(`CREATE TABLE public\\.${t}\\b`))
    const src = fs.readFileSync("scripts/ops/cutover-check.mjs", "utf8")
    expect(src).toContain("begin transaction read only")
    expect(src).toContain("read-only-cutover-check")
    expect(src).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create)\s+(into|table|from|index|role|schema)\b/i)
    expect(src).not.toMatch(/method: "(PUT|PATCH|DELETE)"/)
  })
})

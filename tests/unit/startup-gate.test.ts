import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { HEAD_PROBE } from "@/lib/db/health"

const root = path.resolve(__dirname, "../..")
const migrations = fs.readdirSync(path.join(root, "database/migrations")).filter((f) => f.endsWith(".sql")).sort()

describe("migration head probe (V0.1.54)", () => {
  it("names the newest migration and a function that migration creates", () => {
    const head = migrations[migrations.length - 1].replace(/\.sql$/, "")
    expect(HEAD_PROBE.migration).toBe(head)
    const fn = HEAD_PROBE.signature.replace(/^public\./, "").split("(")[0]
    expect(fs.readFileSync(path.join(root, `database/migrations/${head}.sql`), "utf8")).toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`))
  })

  it("the data-copy tool pins the same head", () => {
    const mapping = fs.readFileSync(path.join(root, "scripts/db/data-copy/mapping.ts"), "utf8")
    expect(mapping).toContain(`"${HEAD_PROBE.migration}"`)
  })
})

describe("backend startup gate", () => {
  const server = fs.readFileSync(path.join(root, "backend/src/server.ts"), "utf8")
  it("in production, refuses an unsafe login or a schema behind the build before listening, but never exits on an unreachable database", () => {
    expect(server).toMatch(/NODE_ENV === "production"/)
    expect(server.indexOf("checkSessionRole")).toBeLessThan(server.indexOf("app.listen"))
    expect(server).toMatch(/role\.reason !== "check_failed"/)
    expect(server).toMatch(/schema\.reason === "behind"/)
  })
})

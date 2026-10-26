import { describe, it, expect } from "vitest"
import fs from "node:fs"

/**
 * V0.1.55: the runbook is an operator contract. These checks pin the properties an
 * edit must not lose: one explicit irreversible boundary, Storage lockdown strictly
 * after it, every command it names exists, and no stub override is mentioned as usable.
 */
const doc = fs.readFileSync("docs/PRODUCTION_CUTOVER.md", "utf8")
const spec = fs.readFileSync("docs/PRODUCTION_DEPLOYMENT_SPEC.md", "utf8")
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))

describe("production runbook (V0.1.55)", () => {
  it("has exactly one irreversible business-data boundary, before the write-enable step and after verification", () => {
    expect(doc.match(/IRREVERSIBLE BUSINESS-DATA BOUNDARY/g)).toHaveLength(1)
    const boundary = doc.indexOf("IRREVERSIBLE BUSINESS-DATA BOUNDARY")
    expect(doc.indexOf("**5.5 Verify Storage reads.**")).toBeLessThan(boundary)
    expect(boundary).toBeLessThan(doc.indexOf("**6.1** *Do:* unset `CARTOONA_WRITE_FREEZE`"))
  })

  it("runs the Storage policy lockdown only after the boundary and the write smoke, as its own boundary", () => {
    const run = doc.indexOf("**7.2** *Do:* run `database/ops/supabase-storage-lockdown.sql`")
    expect(run).toBeGreaterThan(doc.indexOf("**6.2 Smoke"))
    expect(run).toBeGreaterThan(doc.indexOf("IRREVERSIBLE BUSINESS-DATA BOUNDARY"))
    expect(doc).toContain("### Second boundary - Storage policy lockdown")
    // The SQL itself must not be wired into any automatic path.
    expect(doc.slice(0, doc.indexOf("### Phase 7"))).not.toMatch(/\bsupabase-storage-lockdown\.sql`\s*(then|and run)/)
  })

  it("names only commands that exist", () => {
    for (const name of ["production:preflight", "cutover:check", "db:copy"]) {
      expect(pkg.scripts[name], name).toBeTruthy()
      expect(doc, name).toContain(name)
    }
    for (const f of ["scripts/ops/storage-key-check.mjs", "scripts/auth/verify-amr.mjs", "database/ops/create-app-login-role.sql", "database/ops/supabase-storage-lockdown.sql", "docs/PRODUCTION_DEPLOYMENT_SPEC.md"]) {
      expect(fs.existsSync(f), f).toBe(true)
    }
  })

  it("keeps the hard blockers visible and the go/no-go list present", () => {
    expect(doc).toMatch(/Actual production\s+cutover is therefore \*\*NO-GO\*\*/)
    for (const heading of ["## 15. Blocker matrix", "## 16. GO / NO-GO checklist", "## 17. Pending-payment cutover plan", "## 18. Storage lockdown"]) expect(doc).toContain(heading)
    expect(doc).toContain("REAL PAYMENT PROVIDER NOT SELECTED")
  })

  it("never presents the removed stub override as available", () => {
    expect(doc + spec).not.toMatch(/STUB_UNSAFE_ALLOW_IN_PRODUCTION=1/)
  })

  it("the deployment spec requires PostgreSQL 17 and verified TLS and keeps secrets out", () => {
    expect(spec).toMatch(/PostgreSQL 17/)
    expect(spec).toContain("DB_SSL_MODE=verify-full")
    expect(doc + spec).not.toMatch(/postgres(ql)?:\/\/[^\s<$"']+:[^\s<$"'@]{6,}@/)
  })
})

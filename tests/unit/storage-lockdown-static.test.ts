import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const lockdown = fs.readFileSync(path.join(root, "database/ops/supabase-storage-lockdown.sql"), "utf8")
const migrations = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).map((f) => fs.readFileSync(path.join(root, "supabase/migrations", f), "utf8")).join("\n")

/** Latest definition wins: policy name -> its command + whether it is public. */
const created = new Set([...migrations.matchAll(/CREATE POLICY "?(\w+)"? ON storage\.objects/g)].map((m) => m[1]))
const dropped = new Set([...lockdown.matchAll(/DROP POLICY IF EXISTS (\w+) ON storage\.objects/g)].map((m) => m[1]))

describe("Supabase Storage lockdown (V0.1.54)", () => {
  it("drops every Storage policy that authorizes through a Supabase-database function, and only those", () => {
    const publicRead = new Set(["example_media_select_public", "homepage_media_select_public"])
    expect([...dropped].sort()).toEqual([...created].filter((n) => !publicRead.has(n)).sort())
    for (const n of publicRead) expect(dropped.has(n)).toBe(false)
  })

  it("only drops policies the migrations create (no typo that silently matches nothing)", () => {
    for (const n of dropped) expect(created.has(n), n).toBe(true)
  })

  it("is outside both migration chains, transactional and idempotent", () => {
    expect(fs.existsSync(path.join(root, "supabase/migrations/database"))).toBe(false)
    expect(lockdown).toMatch(/^BEGIN;$/m)
    expect(lockdown).toMatch(/^COMMIT;$/m)
    expect(lockdown.replace(/--.*$/gm, "")).not.toMatch(/DROP POLICY (?!IF EXISTS)|DELETE|TRUNCATE|storage\.buckets|DROP (TABLE|FUNCTION)/)
  })

  it("no runtime code reaches Storage with a user session, so dropping the policies cannot break the app", () => {
    const files: string[] = []
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r); else if (/\.(ts|tsx)$/.test(e.name)) files.push(r) } }
    for (const d of ["app", "components", "lib"]) walk(d)
    const storageUsers = files.filter((f) => /\.storage\b/.test(fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
    // Allowed: the four service-credential modules, the signer that receives a service client, the public-URL builders.
    expect(storageUsers.sort()).toEqual([
      "components/admin/examples/example-form.tsx",
      "components/admin/examples/example-list.tsx",
      "lib/storage/example-media.ts",
      "lib/storage/final-deliverables.ts",
      "lib/storage/homepage-media.ts",
      "lib/storage/parent-uploads.ts",
      "lib/storage/private-signed-url.ts",
    ])
    // The two component files only build PUBLIC urls (getPublicUrl performs no request).
    for (const f of ["components/admin/examples/example-form.tsx", "components/admin/examples/example-list.tsx"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8")
      expect([...src.matchAll(/\.storage\s*\.from\([^)]*\)\s*\.(\w+)/g)].map((m) => m[1])).toEqual(["getPublicUrl"])
    }
  })
})

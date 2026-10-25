import { describe, expect, it } from "vitest"
import { KEY_QUERIES, keyFingerprint, runExistenceCheck, usableKey } from "../../scripts/ops/storage-key-check-core.mjs"
import fs from "node:fs"

describe("Storage key existence check (V0.1.54)", () => {
  it("counts present, missing and erroring keys, dedupes, and skips unusable keys", async () => {
    const present = new Set(["a/1", "a/2", "b/1"])
    const r = await runExistenceCheck({
      keysByBucket: { "parent-uploads": ["a/1", "a/1", "a/2", "a/gone", "https://x/y", "../etc", "boom"], "example-media": ["b/1"] },
      exists: async (_b: string, k: string) => { if (k === "boom") throw new Error("net"); return present.has(k) },
      concurrency: 3,
    })
    expect(r.buckets["parent-uploads"]).toMatchObject({ referenced: 6, unusable: 2, checked: 4, missing: 1, errors: 1 })
    expect(r).toMatchObject({ missing: 1, errors: 1, checked: 5, unusable: 2 })
  })

  it("prints a fingerprint, never the key", async () => {
    const r = await runExistenceCheck({ keysByBucket: { x: ["user-1/order-1/photo.png"] }, exists: async () => false })
    expect(r.buckets.x.missingIds).toEqual([keyFingerprint("user-1/order-1/photo.png")])
    expect(JSON.stringify(r)).not.toMatch(/user-1|order-1|photo/)
  })

  it("--sample probes a bounded subset", async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `k/${i}`)
    let calls = 0
    await runExistenceCheck({ keysByBucket: { x: keys }, exists: async () => (calls++, true), sample: 10 })
    expect(calls).toBeLessThanOrEqual(10)
  })

  it.each([["a/b", true], ["", false], ["/abs", false], ["http://x", false], ["a/../b", false]])("usableKey(%s) -> %s", (k, ok) => {
    expect(usableKey(k)).toBe(ok)
  })

  it("reads every table that holds a Storage key, and the script is read-only and gated", () => {
    expect(KEY_QUERIES.map((q: { bucket: string }) => q.bucket)).toEqual(["parent-uploads", "final-deliverables", "homepage-media", "example-media"])
    const script = fs.readFileSync("scripts/ops/storage-key-check.mjs", "utf8")
    expect(script).toMatch(/begin transaction read only/)
    expect(script).toMatch(/CARTOONA_STORAGE_CHECK_CONFIRM !== |confirm !== "read-only-existence-check"/)
    expect(script.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.(upload|remove|copy|move|createSignedUrl)\(|insert |update |delete /i)
  })
})

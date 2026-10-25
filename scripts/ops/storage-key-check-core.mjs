/**
 * Pure core of the Storage key existence check (V0.1.54): which keys PostgreSQL
 * references, per bucket, and a bounded-concurrency existence run. No I/O of its
 * own: the database reader and the Storage `exists` are injected.
 */
export const KEY_QUERIES = [
  { bucket: "parent-uploads", sql: "select file_url as k from public.media_assets where asset_role = 'source' and file_url is not null" },
  { bucket: "final-deliverables", sql: "select file_url as k from public.media_assets where asset_role in ('final','preview','supporting') and file_url is not null" },
  { bucket: "homepage-media", sql: "select storage_path as k from public.homepage_media_assets" },
  { bucket: "example-media", sql: "select media_url as k from public.examples where media_url is not null" },
]

/** A key we can ask Storage about: relative, no scheme, no traversal. Anything else is counted as 'unusable', not probed. */
export function usableKey(k) {
  return typeof k === "string" && k.length > 0 && k.length <= 1024 && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(k) && !k.startsWith("/") && !k.includes("..")
}

/**
 * @param {{ keysByBucket: Record<string, string[]>, exists: (bucket: string, key: string) => Promise<boolean>, concurrency?: number, sample?: number }} o
 * @returns {Promise<any>}
 */
export async function runExistenceCheck({ keysByBucket, exists, concurrency = 8, sample }) {
  const report = { buckets: {}, missing: 0, errors: 0, checked: 0, unusable: 0 }
  for (const [bucket, all] of Object.entries(keysByBucket)) {
    const unique = [...new Set(all)]
    const usable = unique.filter(usableKey)
    const keys = sample && usable.length > sample ? usable.filter((_, i) => i % Math.ceil(usable.length / sample) === 0) : usable
    const b = { referenced: unique.length, unusable: unique.length - usable.length, checked: 0, missing: 0, errors: 0, missingIds: [] }
    let next = 0
    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= keys.length) return
        let r
        try { r = await exists(bucket, keys[i]) } catch { r = "error" }
        b.checked++
        if (r === "error") b.errors++
        else if (!r) {
          b.missing++
          if (b.missingIds.length < 20) b.missingIds.push(keyFingerprint(keys[i]))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
    report.buckets[bucket] = b
    report.missing += b.missing; report.errors += b.errors; report.checked += b.checked; report.unusable += b.unusable
  }
  return report
}

/** Non-reversible short id for a missing key: keys embed user and order ids, so they are not printed. */
import { createHash } from "node:crypto"
export function keyFingerprint(k) {
  return createHash("sha256").update(k).digest("hex").slice(0, 10)
}

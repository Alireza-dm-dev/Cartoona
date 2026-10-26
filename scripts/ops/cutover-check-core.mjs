/**
 * Pure parts of the read-only cutover check (V0.1.55). No I/O here.
 */
import { createHash } from "node:crypto"

/** User-data tables compared between source and target. Seed/catalog tables and audit_logs are excluded. */
export const DATA_TABLES = [
  "users", "parent_profiles", "child_profiles", "orders", "candy_wallets", "candy_transactions",
  "candy_purchases", "payment_attempts", "payment_webhook_events", "media_assets", "coupon_redemptions", "referral_relationships",
]

/** Non-reversible short identity of a database target: never the URL, user or password. */
export function targetFingerprint(connectionString) {
  const url = new URL(connectionString)
  const identity = `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`
  return createHash("sha256").update(identity).digest("hex").slice(0, 12)
}

export const isHostedSupabase = (connectionString) => /(^|\.)supabase\.(co|com|net|in)$/i.test(new URL(connectionString).hostname)
export const isLoopback = (connectionString) => /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(new URL(connectionString).hostname)

/** Applied migration rows vs the files on disk: missing, extra and changed (checksum) versions. */
export function compareMigrations(applied, files) {
  const byVersion = new Map(applied.map((r) => [r.version, r.checksum]))
  const missing = files.filter((f) => !byVersion.has(f.version)).map((f) => f.version)
  const known = new Set(files.map((f) => f.version))
  const extra = applied.filter((r) => !known.has(r.version)).map((r) => r.version)
  const changed = files.filter((f) => byVersion.has(f.version) && byVersion.get(f.version) !== f.checksum).map((f) => f.version)
  return { ok: missing.length + extra.length + changed.length === 0, missing, extra, changed }
}

/** counts: { table: number }. empty = every data table has zero rows. */
export function classifyImportState(counts) {
  const nonEmpty = DATA_TABLES.filter((t) => (counts[t] ?? 0) > 0)
  return nonEmpty.length === 0 ? "empty" : "populated"
}

/** Tables whose row count differs between source and target. */
export function countDifferences(source, target) {
  return DATA_TABLES.filter((t) => source[t] !== target[t]).map((t) => ({ table: t, source: source[t], target: target[t] }))
}

/** What the freeze probe's HTTP answer means. */
export function interpretFreezeProbe(status, body) {
  if (status === 503 && body?.code === "write_freeze") return "frozen"
  if (status === 503) return "unavailable"
  if ([400, 401, 403, 404, 405, 415, 422, 429].includes(status)) return "not_frozen"
  return "unknown"
}

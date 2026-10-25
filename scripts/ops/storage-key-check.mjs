#!/usr/bin/env node
/**
 * READ-ONLY check that every Storage key the PostgreSQL database references
 * exists in Supabase Storage (V0.1.54, cutover step "Storage key validation").
 * Storage bytes are not migrated, so after the data copy this is the proof that
 * no order, gallery item, homepage slot or example points at nothing.
 *
 *   CARTOONA_STORAGE_CHECK_DATABASE_URL=postgresql://<read access>@host/cartoona \
 *   CARTOONA_STORAGE_CHECK_SUPABASE_URL=https://<ref>.supabase.co \
 *   CARTOONA_STORAGE_CHECK_SECRET_KEY=<service credential> \
 *   CARTOONA_STORAGE_CHECK_CONFIRM=read-only-existence-check \
 *   node scripts/ops/storage-key-check.mjs [--sample N] [--concurrency N]
 *
 * It SELECTs inside a READ ONLY transaction and calls Storage `exists` only; it
 * never uploads, signs, lists secrets or writes. Because it can be pointed at
 * production on purpose, it will not start without the CONFIRM value. Output is
 * counts plus a short non-reversible fingerprint of up to 20 missing keys per
 * bucket - never a key, user id, order id or URL. Exit 0 all present, 4 missing
 * or unprobed keys, 2 refused.
 */
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { KEY_QUERIES, runExistenceCheck } from "./storage-key-check-core.mjs"

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : undefined }
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n")
const refuse = (reason) => (out({ result: "refused", reason }), process.exit(2))

const { CARTOONA_STORAGE_CHECK_DATABASE_URL: dbUrl, CARTOONA_STORAGE_CHECK_SUPABASE_URL: sbUrl, CARTOONA_STORAGE_CHECK_SECRET_KEY: key, CARTOONA_STORAGE_CHECK_CONFIRM: confirm } = process.env
if (confirm !== "read-only-existence-check") refuse("CARTOONA_STORAGE_CHECK_CONFIRM=read-only-existence-check is required")
if (!dbUrl || !sbUrl || !key) refuse("database url, supabase url and secret key are required")
if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(sbUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(sbUrl)) refuse("supabase url is not a project url")

const client = new pg.Client({ connectionString: dbUrl })
await client.connect()
const keysByBucket = {}
try {
  await client.query("begin transaction read only")
  for (const q of KEY_QUERIES) keysByBucket[q.bucket] = (await client.query(q.sql)).rows.map((r) => r.k)
  await client.query("rollback")
} finally {
  await client.end()
}

const sb = createClient(sbUrl, key, { auth: { persistSession: false, autoRefreshToken: false } })
const report = await runExistenceCheck({
  keysByBucket,
  concurrency: arg("--concurrency") ?? 8,
  sample: arg("--sample"),
  exists: async (bucket, k) => {
    const { data, error } = await sb.storage.from(bucket).exists(k)
    if (error) throw error
    return data === true
  },
})
const ok = report.missing === 0 && report.errors === 0
out({ result: ok ? "all_present" : "problems", sampled: arg("--sample") ?? null, ...report })
process.exit(ok ? 0 : 4)

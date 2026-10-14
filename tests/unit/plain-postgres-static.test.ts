import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * Static guards for the V0.1.38 plain-PostgreSQL baseline. No database needed:
 * the SQL files are scanned for Supabase dependencies, and the migration
 * runner's fail-closed target checks are exercised with `--check` (which
 * validates and exits before connecting anywhere).
 *
 * The real-SQL behaviour lives in plain-postgres-db.test.ts (opt-in).
 */

const root = path.resolve(__dirname, "../..")
const dir = path.join(root, "database/migrations")
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
const sql = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]))
const all = Object.values(sql).join("\n")

/** SQL with `--` line comments removed, so prose cannot satisfy or break a check. */
const code = all
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")

describe("database/migrations — layout", () => {
  it("is a contiguous, ordered NNNN_name.sql chain", () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
    files.forEach((f, i) => {
      expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/)
      expect(Number(f.slice(0, 4))).toBe(i + 1)
    })
  })

  it("leaves the historical Supabase migrations where they were", () => {
    expect(fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).length).toBeGreaterThanOrEqual(45)
  })
})

describe("database/migrations — no Supabase dependency", () => {
  it("1. references no auth.* object", () => {
    expect(all).not.toMatch(/\bauth\.[a-z_]+/i)
  })

  it("2. references no storage.* object", () => {
    expect(all).not.toMatch(/\bstorage\.(objects|buckets|foldername|filename|extension)\b/i)
    expect(code).not.toMatch(/\bstorage\.[a-z_]+/i)
  })

  it("3. requires no Supabase role", () => {
    expect(all).not.toMatch(/\b(service_role|anon)\b/)
    // A role can only be referenced through these; none may appear at all.
    // As statements (the candy ledger has a 'grant' transaction type).
    expect(code).not.toMatch(/^\s*GRANT\s/im)
    expect(code).not.toMatch(/^\s*CREATE\s+ROLE\b/im)
    expect(code).not.toMatch(/\bOWNER\s+TO\b/i)
    expect(code).not.toMatch(/\bSET\s+(LOCAL\s+)?ROLE\b/i)
  })

  it("4. never calls auth.uid() / auth.jwt() / auth.role()", () => {
    expect(all).not.toMatch(/auth\.(uid|jwt|role)\s*\(/i)
    expect(code).not.toMatch(/request\.jwt/i)
  })

  it("ports no RLS policy", () => {
    expect(code).not.toMatch(/CREATE\s+POLICY/i)
    expect(code).not.toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i)
  })

  it("uses plain pgcrypto in public - no Supabase 'extensions' schema", () => {
    expect(code).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public/)
    expect(all).not.toMatch(/\bextensions\./)
  })

  it("contains no session-lifetime logic tied to Supabase", () => {
    // The Supabase version read the JWT 'session_id' claim and auth sessions.
    // (payment_attempts.provider_session_id is an unrelated payment field.)
    expect(code).not.toMatch(/get_current_parent_session_policy|'session_id'|session_started_at/)
  })

  it("revokes PUBLIC execute on functions", () => {
    expect(code).toMatch(/REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/)
    expect(code).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/)
  })
})

describe("database/migrations — essentials present", () => {
  it("defines every essential domain table", () => {
    for (const t of [
      "users", "user_identities", "parent_profiles", "orders", "media_assets", "order_status_history",
      "candy_wallets", "candy_transactions", "creation_pricing", "coupons", "coupon_redemptions",
      "referral_relationships", "homepage_content", "homepage_media_assets", "homepage_hero_layout",
      "examples", "audit_logs", "parent_welcome_credits", "parent_welcome_credit_usages",
    ]) {
      expect(code, t).toMatch(new RegExp(`CREATE TABLE public\\.${t} \\(`))
    }
  })

  it("keeps the correctness-critical constraints", () => {
    expect(code).toMatch(/orders_submission_key_unique|submission_key/)
    expect(code).toMatch(/ON public\.orders USING btree \(parent_id, submission_key\) WHERE \(submission_key IS NOT NULL\)/)
    expect(code).toMatch(/parent_welcome_credits_not_overspent/)
    expect(code).toMatch(/orders_welcome_credit_image_only|welcome_image_credit/)
    expect(code).toMatch(/candy_wallets_balance_check|CHECK \(\(balance >= 0\)\)/)
    expect(code).toMatch(/user_identities_provider_subject_key UNIQUE \(provider, provider_subject\)/)
  })

  it("keeps the transaction-critical functions and their row locks", () => {
    const fn = /CREATE FUNCTION public\.create_parent_request_trusted\([\s\S]*?\n\$\$;/.exec(code)?.[0] ?? ""
    expect(fn).toMatch(/p_file_mime_type text DEFAULT NULL::text/)
    expect((fn.match(/FOR UPDATE;/g) ?? []).length).toBe(2) // wallet, then welcome credits
    expect(fn).toMatch(/ON CONFLICT \(parent_id, submission_key\) WHERE submission_key IS NOT NULL DO NOTHING/)
    for (const f of [
      "complete_candy_purchase_trusted", "apply_coupon_to_purchase_trusted", "update_coupon_trusted",
      "update_order_status_trusted", "record_final_media_trusted", "approve_final_media_trusted",
      "bind_parent_referral_code_trusted", "update_admin_referral_program_settings_trusted",
    ]) {
      expect(code, f).toMatch(new RegExp(`CREATE FUNCTION public\\.${f}\\(`))
    }
  })

  it("keeps append-only protections, and adds the ones RLS used to provide", () => {
    for (const t of [
      "prevent_candy_transaction_mutation", "order_status_history_append_only_trigger",
      "trg_prevent_settings_history_update", "audit_logs_append_only", "moderation_logs_append_only",
      "parent_welcome_credit_usages_append_only",
    ]) {
      expect(code, t).toMatch(new RegExp(`CREATE TRIGGER ${t}\\b`))
    }
  })
})

// ── migrate-local.sh: fails closed ──────────────────────────────────────────

const runner = path.join(root, "scripts/db/migrate-local.sh")

function runCheck(env: Record<string, string | undefined>) {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v
  const r = spawnSync("bash", [runner, "--check"], { env: clean, encoding: "utf8" })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe("scripts/db/migrate-local.sh — target safety", () => {
  it("is executable and contains no credentials", () => {
    expect(fs.statSync(runner).mode & 0o111).not.toBe(0)
    const text = fs.readFileSync(runner, "utf8")
    // No real user:password@ in a URL (doc placeholders like <password> are fine).
    expect(text).not.toMatch(/postgres(ql)?:\/\/[A-Za-z0-9_.-]+:[A-Za-z0-9_.~%!$&*+=-]{3,}@/)
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
    expect(text).not.toMatch(/source\s+\S*\.env|\.env\.(local|docker)\b(?!\.)/)
  })

  it.each([
    ["missing target", {}, /DATABASE_URL is not set/],
    ["production project ref", { DATABASE_URL: "postgresql://postgres:x@db.oucyhmrnzahlhqjfqcge.supabase.co:5432/postgres" }, /Cartoona Supabase project/],
    ["production ref on a loopback-looking URL", { DATABASE_URL: "postgresql://oucyhmrnzahlhqjfqcge@localhost:5433/cartoona" }, /Cartoona Supabase project/],
    ["hosted Supabase endpoint", { DATABASE_URL: "postgresql://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/app" }, /hosted Supabase/],
    ["Supabase pooler", { DATABASE_URL: "postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres" }, /hosted Supabase/],
    ["non-local host", { DATABASE_URL: "postgresql://u:p@db.example.com:5432/app" }, /is not local/],
    ["LAN address", { DATABASE_URL: "postgresql://u:p@192.168.1.20:5433/app" }, /is not local/],
    ["query-string override", { DATABASE_URL: "postgresql://u:p@localhost:5433/app?host=db.example.com" }, /query parameters/],
    ["several hosts", { DATABASE_URL: "postgresql://u:p@localhost:5433,db.example.com:5432/app" }, /several hosts/],
    ["no database name", { DATABASE_URL: "postgresql://u:p@localhost:5433" }, /must look like/],
    ["maintenance database", { DATABASE_URL: "postgresql://u:p@localhost:5433/postgres" }, /maintenance database/],
    ["PGHOST shadowing", { DATABASE_URL: "postgresql://u:p@localhost:5433/app", PGHOST: "db.example.com" }, /PGHOST is set/],
    ["PGDATABASE shadowing", { DATABASE_URL: "postgresql://u:p@localhost:5433/app", PGDATABASE: "other" }, /PGDATABASE is set/],
    ["PGSERVICE shadowing", { DATABASE_URL: "postgresql://u:p@localhost:5433/app", PGSERVICE: "prod" }, /PGSERVICE is set/],
    ["non-postgres scheme", { DATABASE_URL: "mysql://u:p@localhost:3306/app" }, /must look like/],
  ])("refuses: %s", (_name, env, message) => {
    const r = runCheck(env)
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/REFUSED/)
    expect(r.out).toMatch(message)
  })

  it.each([
    ["host loopback, published port", "postgresql://cartoona:s3cret-pw@localhost:5433/cartoona", "cartoona@localhost:5433/cartoona"],
    ["127.0.0.1", "postgresql://cartoona:s3cret-pw@127.0.0.1:5433/cartoona_schema_test", "cartoona@127.0.0.1:5433/cartoona_schema_test"],
    ["compose service name", "postgresql://cartoona@postgres:5432/cartoona", "cartoona@postgres:5432/cartoona"],
  ])("accepts %s and states the target without the password", (_name, url, shown) => {
    const r = runCheck({ DATABASE_URL: url })
    expect(r.status).toBe(0)
    expect(r.out).toContain(`target ${shown}`)
    expect(r.out).not.toContain("s3cret-pw")
    expect(r.out).toMatch(/--check only, nothing applied/)
  })

  it("refuses the project the Supabase CLI in this checkout is linked to", () => {
    const linked = path.join(root, "supabase/.temp/project-ref")
    if (!fs.existsSync(linked)) return
    const ref = fs.readFileSync(linked, "utf8").trim()
    const r = runCheck({ DATABASE_URL: `postgresql://u@localhost:5433/${ref}` })
    expect(r.status).toBe(2)
  })
})

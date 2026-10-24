import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type net from "node:net"
import { Client } from "pg"
import type { FastifyInstance } from "fastify"
import { runDataCopy, type CopyResult } from "@/scripts/db/data-copy/copy"
import { backfillSupabaseIdentities } from "@/scripts/db/data-copy/identity"
import { COPIED_TABLES, META_SCHEMA } from "@/scripts/db/data-copy/mapping"
import { databaseIdentity } from "@/scripts/db/data-copy/preflight"
import { DataCopyError } from "@/scripts/db/data-copy/safety"
import { buildBackendApp } from "@/backend/src/app"
import { closePool, getPool } from "@/lib/db/pool"
import { signAssertion } from "@/lib/identity/assertion"
import { toVerifiedIdentity } from "@/lib/identity/types"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import { getParentOrdersPage } from "@/lib/repositories/parent-orders"
import { attempt, buildSupabaseSource, createDb, dropDbs, migrateTarget, ownerUrl, pgEnv, psql, root, script, snapshot, type PgEnv } from "../helpers/data-copy-db"

/**
 * V0.1.44 data copy, end to end, against REAL PostgreSQL 17 (opt-in:
 * CARTOONA_PLAIN_PG=docker, compose `postgres` running).
 *
 *   Supabase-shaped source (stub + the real supabase/migrations chain + the
 *   realistic fixture) -> copy tool -> freshly migrated plain target (0001-0015)
 *
 * then reconciliation, idempotency, resumability, conflict refusals, the
 * V0.1.42/43 auth chain and the parent-orders repository on the copied data.
 * Every database is uniquely named in the local container and dropped
 * afterwards. Nothing contacts Supabase.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const SRC = `dcs_${id}`
const FRESH = `dcf_${id}` // migrated, never copied into: the template for every target
const TGT = `dct_${id}`
const ROLE = `cartoona_app_dc${id}`
const DB_PASSWORD = randomBytes(24).toString("hex")
const AUTH_SECRET = randomBytes(32).toString("hex")
const FIXTURE = path.join(root, "tests/fixtures/data-copy/supabase-source-fixture.sql")
const created: string[] = [SRC, FRESH, TGT]

const U = {
  parentA: "a1000000-0000-4000-8000-000000000001",
  parentB: "a1000000-0000-4000-8000-000000000002",
  admin: "a1000000-0000-4000-8000-000000000003",
  deleted: "a1000000-0000-4000-8000-000000000004",
  superAdmin: "a1000000-0000-4000-8000-000000000005",
}
const P = { a: "b1000000-0000-4000-8000-000000000001", b: "b1000000-0000-4000-8000-000000000002", deleted: "b1000000-0000-4000-8000-000000000004" }
const order = (n: number) => `a2000000-0000-4000-8000-00000000000${n}`

let env: PgEnv
let first: CopyResult
const logs: string[] = []

async function copy(source: string, target: string, extra: Partial<Parameters<typeof runDataCopy>[0]> = {}) {
  return runDataCopy({
    sourceUrl: ownerUrl(env, source),
    targetUrl: ownerUrl(env, target),
    migrationsDir: path.join(root, "database/migrations"),
    env: {},
    log: (l) => logs.push(l),
    ...extra,
  })
}

async function refused(p: Promise<unknown>): Promise<DataCopyError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(DataCopyError)
    return e as DataCopyError
  }
  throw new Error("expected the copy to be refused")
}

/** A clone of the source with a deliberate defect (constraints dropped as a constraint-less dump restore would). */
async function brokenSource(name: string, sql: string): Promise<string> {
  const db = await cloneOf(name, SRC)
  await psql(env, db, sql)
  return db
}

async function cloneOf(name: string, template: string): Promise<string> {
  const db = `${name}_${id}`
  created.push(db)
  await createDb(env, db, template)
  return db
}
const freshTarget = (name: string) => cloneOf(name, FRESH)

/** The target is exactly as migrated: no bookkeeping, no copied rows. */
async function expectUntouched(db: string) {
  expect(await psql(env, db, `select to_regclass('${META_SCHEMA}.runs') is null`)).toBe("t")
  expect(await psql(env, db, "select (select count(*) from public.users) + (select count(*) from public.orders) + (select count(*) from public.user_identities)")).toBe("0")
  expect(await psql(env, db, "select count(*) from public.creation_pricing")).toBe("9")
}

const q = (db: string, sql: string) => psql(env, db, sql)

describe.skipIf(!enabled)("V0.1.44 data copy: Supabase-shaped source -> plain PostgreSQL (local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 })

  beforeAll(async () => {
    env = await pgEnv()
    await buildSupabaseSource(env, SRC, FIXTURE)
    expect(await migrateTarget(env, FRESH)).toMatch(/done - 15 applied/)
    await createDb(env, TGT, FRESH)
    first = await copy(SRC, TGT)
  })

  afterAll(async () => {
    if (!env) return
    await closePool()
    await dropDbs(env, created)
    await psql(env, "postgres", `drop role if exists ${ROLE}`).catch(() => undefined)
  })

  describe("21. full local copy", () => {
    it("completes, and the source passes every check before anything is written", () => {
      expect(first.outcome).toBe("completed")
      expect(first.sourceChecks.filter((c) => c.severity === "error" && c.count > 0)).toEqual([])
      expect(first.targetChecks.filter((c) => c.count > 0)).toEqual([])
      expect(first.manifest.validation.preservation).toEqual({ tables: COPIED_TABLES.length, mismatches: [] })
    })

    it("expected row counts, equal to the source for every copied table", async () => {
      const expected: Record<string, number> = {
        users: 5, user_identities: 5, parent_profiles: 3, candy_wallets: 3, parent_welcome_credits: 3, child_profiles: 1,
        orders: 8, order_status_history: 6, media_assets: 4, video_requests: 1, drawing_animation_requests: 1,
        parent_welcome_credit_usages: 5, candy_transactions: 5, candy_purchases: 3, payment_attempts: 2, payment_webhook_events: 1,
        coupons: 1, coupon_package_rules: 1, coupon_redemptions: 1, referral_relationships: 1, referral_binding_rate_limits: 1,
        referral_program_settings: 1, referral_program_settings_history: 1, creation_pricing: 9, candy_packages: 3, characters: 10,
        homepage_content: 1, homepage_hero_layout: 1, homepage_media_assets: 1, examples: 1, audit_logs: 2, moderation_logs: 1,
      }
      for (const [table, n] of Object.entries(expected)) {
        expect(Number(await q(TGT, `select count(*) from public.${table}`)), table).toBe(n)
        if (table !== "user_identities") expect(Number(await q(SRC, `select count(*) from public.${table}`)), `source ${table}`).toBe(n)
      }
    })

    it("preserves ids: users keep their Supabase auth UUIDs; orders, wallets, media keep theirs", async () => {
      expect(await q(TGT, "select string_agg(id::text, ',' order by id) from public.users")).toBe(Object.values(U).sort().join(","))
      expect(await q(TGT, "select string_agg(id::text, ',' order by id) from public.users")).toBe(await q(SRC, "select string_agg(id::text, ',' order by id) from auth.users"))
      for (const t of ["orders", "candy_wallets", "media_assets", "candy_transactions", "parent_profiles", "creation_pricing", "characters", "candy_packages"]) {
        expect(await q(TGT, `select md5(string_agg(id::text, ',' order by id)) from public.${t}`), t).toBe(await q(SRC, `select md5(string_agg(id::text, ',' order by id)) from public.${t}`))
      }
    })

    it("all foreign keys valid (enforced throughout, and re-checked)", async () => {
      expect(await q(TGT, "select count(*) from pg_constraint where connamespace = 'public'::regnamespace and contype = 'f' and not convalidated")).toBe("0")
      expect(first.targetChecks.filter((c) => c.check.startsWith("fk_orphan:")).length).toBeGreaterThan(35)
      expect(first.targetChecks.filter((c) => c.check.startsWith("fk_orphan:") && c.count > 0)).toEqual([])
    })

    it("identity backfill: ('supabase', users.id) for every user, deleted included, deterministic", async () => {
      expect(await q(TGT, "select count(*) from public.user_identities where provider = 'supabase' and provider_subject = user_id::text")).toBe("5")
      expect(await q(TGT, "select count(*) from public.user_identities where id <> md5('cartoona-identity:supabase:' || user_id::text)::uuid")).toBe("0")
      expect(await q(TGT, "select count(*) from public.user_identities i join public.users u on u.id = i.user_id where i.created_at <> u.created_at")).toBe("0")
      expect(await q(TGT, `select count(*) from public.user_identities where user_id = '${U.deleted}'`)).toBe("1")
    })

    it("no duplicate profiles, wallets or welcome grants; referral codes and wallet ids are the historical ones", async () => {
      for (const t of ["parent_profiles", "candy_wallets", "parent_welcome_credits"]) {
        const cols = t === "parent_welcome_credits" ? "parent_id, granted_count, used_count, granted_at" : t === "candy_wallets" ? "id, parent_id, balance" : "id, user_id, referral_code"
        expect(await q(TGT, `select string_agg(x::text, ';' order by x::text) from (select ${cols} from public.${t}) x`), t)
          .toBe(await q(SRC, `select string_agg(x::text, ';' order by x::text) from (select ${cols} from public.${t}) x`))
      }
      expect(await q(TGT, "select string_agg(id::text, ',' order by id) from public.candy_wallets")).toBe(
        "c1000000-0000-4000-8000-000000000001,c1000000-0000-4000-8000-000000000002,c1000000-0000-4000-8000-000000000004",
      )
    })

    it("wallet reconciliation clean: balance = signed ledger sum, values unchanged", async () => {
      expect(await q(TGT, `select string_agg(w.parent_id || '=' || w.balance || '/' || coalesce((select sum(amount) from public.candy_transactions t where t.wallet_id = w.id), 0), ',' order by w.parent_id) from public.candy_wallets w`))
        .toBe(`${P.a}=648/648,${P.b}=665/665,${P.deleted}=0/0`)
    })

    it("welcome-credit reconciliation clean: used = usages, and every usage is a credit-paid image", async () => {
      expect(await q(TGT, "select string_agg(parent_id || '=' || granted_count || '/' || used_count, ',' order by parent_id) from public.parent_welcome_credits")).toBe(`${P.a}=3/3,${P.b}=3/1,${P.deleted}=3/1`)
      expect(await q(TGT, "select count(*) from public.orders where payment_source = 'welcome_image_credit' and type = 'image' and candy_cost = 0")).toBe("5")
      expect(await q(TGT, "select count(*) from public.parent_welcome_credit_usages u join public.orders o on o.id = u.order_id and o.parent_id = u.parent_id and o.payment_source = 'welcome_image_credit'")).toBe("5")
    })

    it("order relationships, child_name, submission_key, timestamps and history are preserved exactly", async () => {
      const cols = "id, parent_id, type, status, child_name, submission_key, payment_source, candy_cost, character_id, created_at, updated_at"
      expect(await q(TGT, `select md5(string_agg(x::text, ';' order by x.id)) from (select ${cols} from public.orders) x`)).toBe(await q(SRC, `select md5(string_agg(x::text, ';' order by x.id)) from (select ${cols} from public.orders) x`))
      expect(await q(TGT, `select child_name || '|' || submission_key || '|' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from public.orders where id = '${order(1)}'`))
        .toBe("Sara|a3000000-0000-4000-8000-000000000001|2026-09-01 11:00:00.000001")
      expect(await q(TGT, `select to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from public.order_status_history where order_id = '${order(1)}' and new_status = 'delivered'`)).toBe("2026-09-02 10:00:00.345678")
      expect(await q(TGT, "select count(*) from (select parent_id, submission_key from public.orders where submission_key is not null group by 1, 2 having count(*) > 1) d")).toBe("0")
      // FK cycle second pass: active attempt restored, updated_at NOT rewritten by the bypassed trigger.
      expect(await q(TGT, "select string_agg(id || ':' || coalesce(active_payment_attempt_id::text, '-') || ':' || updated_at, ',' order by id) from public.candy_purchases"))
        .toBe(await q(SRC, "select string_agg(id || ':' || coalesce(active_payment_attempt_id::text, '-') || ':' || updated_at, ',' order by id) from public.candy_purchases"))
    })

    it("media metadata only: keys, MIME, sizes, roles and flags preserved; no storage schema in the target", async () => {
      const cols = "id, order_id, type, asset_role, delivery_status, file_url, mime_type, byte_size, original_filename, parent_visible, superseded_at, uploaded_by_user_id"
      expect(await q(TGT, `select md5(string_agg(x::text, ';' order by x.id)) from (select ${cols} from public.media_assets) x`)).toBe(await q(SRC, `select md5(string_agg(x::text, ';' order by x.id)) from (select ${cols} from public.media_assets) x`))
      expect(await q(SRC, "select count(*) from storage.objects")).toBe("4")
      expect(await q(TGT, "select count(*) from pg_namespace where nspname = 'storage'")).toBe("0")
    })

    it("audit and moderation history preserved, and append-only protection is active again", async () => {
      expect(await q(TGT, "select md5(string_agg(x::text, ';' order by x.id)) from public.audit_logs x")).toBe(await q(SRC, "select md5(string_agg(x::text, ';' order by x.id)) from public.audit_logs x"))
      expect((await attempt(env, TGT, "update public.audit_logs set action = 'x'")).err).toMatch(/audit_logs_append_only/)
      expect((await attempt(env, TGT, "delete from public.moderation_logs")).err).toMatch(/moderation_logs_append_only/)
      expect((await attempt(env, TGT, "update public.candy_transactions set amount = 1")).err).toMatch(/append-only/)
      expect((await attempt(env, TGT, "delete from public.order_status_history")).err).toMatch(/order_status_history_append_only/)
    })

    it("every trigger is enabled again, and the bypassed ones fire for new rows", async () => {
      expect(await q(TGT, "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgenabled <> 'O'")).toBe("0")
      const clone = await cloneOf("dctrig", TGT)
      const user = "a1000000-0000-4000-8000-0000000000aa"
      await q(clone, `insert into public.users (id, role) values ('${user}', 'parent')`)
      await q(clone, `insert into public.parent_profiles (user_id, referral_code) values ('${user}', 'CT000000000000')`)
      expect(await q(clone, `select (referral_code <> 'CT000000000000')::text || ',' || (select count(*) from public.candy_wallets w where w.parent_id = p.id) || ',' || (select granted_count from public.parent_welcome_credits c where c.parent_id = p.id) from public.parent_profiles p where user_id = '${user}'`))
        .toBe("true,1,3")
    })

    it("soft-deleted users stay deleted (exact timestamp); sessions_not_before is NULL for everyone", async () => {
      expect(await q(TGT, `select deleted_at from public.users where id = '${U.deleted}'`)).toBe(await q(SRC, `select deleted_at from public.users where id = '${U.deleted}'`))
      expect(await q(TGT, "select count(*) from public.users where deleted_at is not null")).toBe("1")
      expect(await q(TGT, "select count(*) from public.users where sessions_not_before is not null")).toBe("0")
    })

    it("reference data is the source's business data: replaced, never duplicated", async () => {
      expect(await q(TGT, "select md5(string_agg(x::text, ';' order by x.id)) from public.creation_pricing x")).toBe(await q(SRC, "select md5(string_agg(x::text, ';' order by x.id)) from public.creation_pricing x"))
      expect(await q(TGT, "select count(*) - count(distinct pricing_key) from public.creation_pricing")).toBe("0")
      expect(await q(TGT, "select reward_basis_points || ',' || updated_by from public.referral_program_settings")).toBe(`2000,${U.admin}`)
      expect(await q(TGT, "select content_json->>'fixtureEdited' from public.homepage_content")).toBe("true")
    })

    it("manifest and bookkeeping: safe metadata only, inaccessible to the application role", async () => {
      const stored = await q(TGT, `select manifest::text from ${META_SCHEMA}.runs`)
      const m = JSON.parse(stored)
      expect(m.outcome).toBe("completed")
      expect(m.target.migrations).toHaveLength(15)
      expect(m.target.serverVersion).toMatch(/^17/)
      expect(m.bypassedTriggers.map((b: { trigger: string }) => b.trigger).sort()).toEqual(
        ["assign_parent_referral_code", "candy_purchases_set_updated_at", "ensure_parent_candy_wallet", "grant_parent_welcome_image_credits"],
      )
      expect(stored).not.toMatch(/@|fixture\.invalid|Parent A|Sara|sim-ref|WELCOME10/)
      expect(stored).not.toContain(env.password)
      expect(await q(TGT, `select string_agg(phase, ',' order by completed_at) from ${META_SCHEMA}.phases`)).toBe("users,reference,parents,commerce,orders,ledger,content_and_logs")
      expect(await q(TGT, `select has_schema_privilege('cartoona_app', '${META_SCHEMA}', 'USAGE')`)).toBe("f")
      expect(logs.join("\n")).not.toContain(env.password)
    })
  })

  describe("22. idempotency: the same copy again is a verified no-op", () => {
    it("second run writes nothing and changes nothing", async () => {
      const before = await snapshot(env, TGT)
      const again = await copy(SRC, TGT)
      expect(again.outcome).toBe("verified_noop")
      expect(again.manifest.runId).toBe(first.manifest.runId)
      expect(await snapshot(env, TGT)).toEqual(before)
      expect(await q(TGT, `select count(*) || ',' || min(status) from ${META_SCHEMA}.runs`)).toBe("1,completed")
    })

    it("a completed target refuses a DIFFERENT source state", async () => {
      const changed = await brokenSource("dcsx", "insert into public.audit_logs (actor_id, action, target_type, target_id) values (null, 'later', 'x', gen_random_uuid())")
      const e = await refused(copy(changed, TGT))
      expect(e.code).toBe("target_holds_other_copy")
      expect(e.exitCode).toBe(3)
    })
  })

  describe("resumability and phase rollback", () => {
    it("a staged run stops after a phase, and the rerun resumes and completes", async () => {
      const t = await freshTarget("dcr")
      expect((await copy(SRC, t, { stopAfterPhase: "parents" })).outcome).toBe("stopped")
      expect(await q(t, "select (select count(*) from public.parent_profiles) || ',' || (select count(*) from public.orders)")).toBe("3,0")
      const resumed = await copy(SRC, t)
      expect(resumed.outcome).toBe("resumed_completed")
      expect(resumed.manifest.phases.map((p) => p.name)).toEqual(["commerce", "orders", "ledger", "content_and_logs"])
      expect(await snapshot(env, t)).toEqual(await snapshot(env, TGT))
    })

    it("an integrity error rolls back only the current phase (triggers restored); fixing it and rerunning completes", async () => {
      const t = await freshTarget("dcp")
      await q(t, `create function public.zz_trap() returns trigger language plpgsql as $$ begin raise exception 'simulated integrity error'; end $$;
                  create trigger zz_trap before insert on public.orders for each row execute function public.zz_trap()`)
      const e = await refused(copy(SRC, t))
      expect(e.code).toBe("phase_failed")
      expect(e.message).toMatch(/Phase 'orders' failed at table orders and was rolled back: simulated integrity error/)
      expect(await q(t, `select string_agg(phase, ',' order by completed_at) from ${META_SCHEMA}.phases`)).toBe("users,reference,parents,commerce")
      expect(await q(t, "select (select count(*) from public.orders) + (select count(*) from public.video_requests) + (select count(*) from public.order_status_history)")).toBe("0")
      expect(await q(t, "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'parent_profiles' and not t.tgisinternal and t.tgenabled <> 'O'")).toBe("0")
      await q(t, "drop trigger zz_trap on public.orders; drop function public.zz_trap()")
      expect((await copy(SRC, t)).outcome).toBe("resumed_completed")
    })

    it("a resume refuses when the source changed in between", async () => {
      const t = await freshTarget("dcrc")
      await copy(SRC, t, { stopAfterPhase: "users" })
      const changed = await brokenSource("dcsy", "update public.users set email = 'changed@fixture.invalid' where id = 'a1000000-0000-4000-8000-000000000002'")
      expect((await refused(copy(changed, t))).code).toBe("source_changed")
    })
  })

  describe("23. conflicts fail safely, with nothing written and nothing auto-healed", () => {
    it("conflicting identity mapping: the backfill refuses and writes nothing", async () => {
      const t = await cloneOf("dcid", TGT)
      // admin's subject now points at parent A, and A has a second supabase subject.
      await q(t, `delete from public.user_identities where user_id = '${U.admin}';
                  insert into public.user_identities (user_id, provider, provider_subject) values ('${U.parentA}', 'supabase', '${U.admin}')`)
      const client = new Client({ connectionString: ownerUrl(env, t) })
      await client.connect()
      try {
        await client.query("BEGIN")
        const e = await refused(backfillSupabaseIdentities(client))
        await client.query("ROLLBACK")
        expect(e.code).toBe("identity_conflict")
        expect(e.details).toEqual([
          `subject ${U.admin} is mapped to user ${U.parentA}, expected ${U.admin}`,
          `user ${U.parentA} already has supabase subject ${U.admin}`,
        ])
      } finally {
        await client.end()
      }
      expect(await q(t, "select count(*) from public.user_identities")).toBe("5")
      // and the copy tool refuses to call that target valid
      const e2 = await refused(copy(SRC, t))
      expect(e2.code).toBe("validation_failed")
      expect(e2.details.join("\n")).toMatch(/identity_missing x1[\s\S]*identity_conflict x1/)
    })

    const sourceCases: [string, string, string, RegExp][] = [
      ["missing parent user", "dcm1",
        "alter table public.parent_profiles drop constraint parent_profiles_user_id_fkey; insert into public.parent_profiles (id, user_id) values ('b1000000-0000-4000-8000-0000000000ff', 'a1000000-0000-4000-8000-0000000000ff')",
        /fk_orphan:parent_profiles\.user_id->users x1: a1000000-0000-4000-8000-0000000000ff/],
      ["invalid FK (media of a missing order)", "dcm2",
        "alter table public.media_assets drop constraint media_assets_order_id_fkey; insert into public.media_assets (id, order_id, type, file_url) values ('a5000000-0000-4000-8000-0000000000ff', 'a2000000-0000-4000-8000-0000000000ff', 'upload', 'x/y/z.png')",
        /fk_orphan:media_assets\.order_id->orders x1/],
      ["duplicate submission key", "dcm3",
        `drop index public.orders_parent_submission_key_key; insert into public.orders (id, parent_id, type, status, candy_cost, submission_key, payment_source) values ('a2000000-0000-4000-8000-0000000000ff', '${P.a}', 'image', 'pending_review', 0, 'a3000000-0000-4000-8000-000000000001', 'candy')`,
        /duplicate_submission_key x1: b1000000-0000-4000-8000-000000000001 submission_key=a3000000-0000-4000-8000-000000000001/],
      ["broken wallet reconciliation", "dcm4",
        `update public.candy_wallets set balance = balance + 5 where parent_id = '${P.b}'`,
        /wallet_balance_mismatch x1: parent_profile=b1000000-0000-4000-8000-000000000002 wallet=c1000000-0000-4000-8000-000000000002 balance=670 ledger_sum=665/],
      ["used_count > granted_count", "dcm5",
        `alter table public.parent_welcome_credits drop constraint parent_welcome_credits_not_overspent; update public.parent_welcome_credits set used_count = 4 where parent_id = '${P.a}'`,
        /welcome_used_exceeds_granted x1: parent_profile=b1000000-0000-4000-8000-000000000001 granted=3 used=4/],
    ]
    for (const [label, name, sql, detail] of sourceCases) {
      it(`${label}: source refused before any write`, async () => {
        const src = await brokenSource(name, sql)
        const t = await freshTarget(`${name}t`)
        const e = await refused(copy(src, t))
        expect(e.code).toBe("source_integrity")
        expect(e.exitCode).toBe(4)
        expect(e.details.join("\n")).toMatch(detail)
        await expectUntouched(t)
      })
    }

    it("target already contains unrelated records: refused", async () => {
      const t1 = await freshTarget("dcu1")
      await q(t1, "insert into public.users (email) values (null)")
      const e = await refused(copy(SRC, t1))
      expect(e.code).toBe("target_not_empty")
      expect(e.exitCode).toBe(3)
      expect(e.details).toContain("users: 1 row(s), expected 0")
      const t2 = await freshTarget("dcu2")
      await q(t2, "insert into public.creation_pricing (pricing_key, candy_cost) values ('extra', 1)")
      expect((await refused(copy(SRC, t2))).details).toContain("creation_pricing: 10 row(s), expected 9")
      expect(await q(t2, `select to_regclass('${META_SCHEMA}.runs') is null`)).toBe("t")
    })

    it("schema version mismatch: missing migration, edited checksum, incompatible or plain source", async () => {
      const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-migrations-"))
      for (const f of fs.readdirSync(path.join(root, "database/migrations")).filter((f) => !f.startsWith("0011"))) {
        fs.copyFileSync(path.join(root, "database/migrations", f), path.join(partialDir, f))
      }
      const t10 = `dc10_${id}`
      created.push(t10)
      await migrateTarget(env, t10, partialDir)
      fs.rmSync(partialDir, { recursive: true, force: true })
      const e1 = await refused(copy(SRC, t10))
      expect(e1.code).toBe("target_schema_mismatch")
      expect(e1.details).toEqual(["not applied: 0011_users_sessions_not_before"])

      const tck = await freshTarget("dcck")
      await q(tck, "update public.schema_migrations set checksum = repeat('0', 64) where version = '0005_business_functions'")
      expect((await refused(copy(SRC, tck))).details).toEqual(["checksum differs from database/migrations: 0005_business_functions"])

      const noCol = await brokenSource("dcsc", "alter table public.orders drop column child_name")
      const t = await freshTarget("dcsct")
      const e3 = await refused(copy(noCol, t))
      expect(e3.code).toBe("source_schema_incompatible")
      expect(e3.details).toEqual(["missing column public.orders.child_name"])

      const extraCol = await brokenSource("dcse", "alter table public.orders add column legacy_note text")
      expect((await refused(copy(extraCol, t))).details).toEqual(["source column public.orders.legacy_note has no target column (its data would be lost)"])

      expect((await refused(copy(FRESH, t))).code).toBe("source_schema_incompatible")
      await expectUntouched(t)
    })

    it("source and target must differ (by URL, and by the database actually reached)", async () => {
      expect((await refused(copy(TGT, TGT))).code).toBe("same_database")
      const a = new Client({ connectionString: ownerUrl(env, TGT, "localhost") })
      const b = new Client({ connectionString: ownerUrl(env, TGT) })
      const c = new Client({ connectionString: ownerUrl(env, SRC) })
      await Promise.all([a.connect(), b.connect(), c.connect()])
      try {
        expect(await databaseIdentity(a)).toBe(await databaseIdentity(b))
        expect(await databaseIdentity(a)).not.toBe(await databaseIdentity(c))
      } finally {
        await Promise.all([a.end(), b.end(), c.end()])
      }
    })

    it("the CLI exits non-zero with a reason, and never prints a credential", async () => {
      const t = await freshTarget("dccli")
      await q(t, "insert into public.users (email) values (null)")
      const out = await new Promise<{ code: number; text: string }>((resolve) => {
        const child = spawn(process.execPath, [path.join(root, "scripts/db/copy-supabase-to-plain.mjs")], {
          cwd: root,
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", CARTOONA_COPY_SOURCE_URL: ownerUrl(env, SRC), CARTOONA_COPY_TARGET_URL: ownerUrl(env, t) },
        })
        let text = ""
        child.stdout.on("data", (d) => (text += d))
        child.stderr.on("data", (d) => (text += d))
        child.on("close", (code) => resolve({ code: code ?? -1, text }))
      })
      expect(out.code).toBe(3)
      expect(out.text).toMatch(/REFUSED\/FAILED \[target_not_empty\]/)
      expect(out.text).not.toContain(env.password)
    })
  })

  describe("24/25. the copied data works with the V0.1.42/43 auth chain and the parent-orders repository", () => {
    let backend: FastifyInstance | null = null
    let base = ""

    beforeAll(async () => {
      const r = await script(env, "scripts/db/app-login-role.sh", { DATABASE_URL: `postgresql://cartoona@postgres:5432/${TGT}`, CARTOONA_APP_DB_PASSWORD: DB_PASSWORD }, [ROLE])
      expect(r.code).toBe(0)
      vi.stubEnv("DATABASE_URL", `postgresql://${ROLE}:${DB_PASSWORD}@127.0.0.1:${env.port}/${TGT}`)
      vi.stubEnv("CARTOONA_INTERNAL_AUTH_SECRET", AUTH_SECRET)
      backend = buildBackendApp()
      await backend.listen({ host: "127.0.0.1", port: 0 })
      base = `http://127.0.0.1:${(backend.server.address() as net.AddressInfo).port}`
    })

    afterAll(async () => {
      await backend?.close()
      await closePool()
      vi.unstubAllEnvs()
    })

    const me = async (subject: string) => {
      const assertion = signAssertion({
        identity: toVerifiedIdentity({ provider: "supabase", subject }),
        authenticatedAt: Date.now() - 60_000,
        requestId: "data-copy-proof-1",
        method: "GET",
        path: "/v1/auth/me",
        secret: Buffer.from(AUTH_SECRET, "hex"),
      })
      const res = await fetch(`${base}/v1/auth/me`, { headers: { "x-cartoona-internal-auth": assertion } })
      return { status: res.status, body: await res.json() }
    }

    it("24. requireAuth resolves each copied Supabase subject to the copied user and role", async () => {
      expect(await me(U.parentA)).toEqual({ status: 200, body: { authenticated: true, userId: U.parentA, role: "parent" } })
      expect(await me(U.admin)).toEqual({ status: 200, body: { authenticated: true, userId: U.admin, role: "admin" } })
      expect(await me(U.superAdmin)).toEqual({ status: 200, body: { authenticated: true, userId: U.superAdmin, role: "super_admin" } })
    })

    it("24. a soft-deleted copied user -> 403; an unknown subject -> identity_not_linked", async () => {
      expect(await me(U.deleted)).toEqual({ status: 403, body: { error: "forbidden" } })
      expect(await me("a1000000-0000-4000-8000-0000000000ee")).toEqual({ status: 403, body: { error: "identity_not_linked" } })
    })

    it("25. a copied parent sees exactly their own orders, paginated, with completion times from copied history", async () => {
      const profile = await findParentProfileIdByUserId(getPool(), { userId: U.parentA })
      expect(profile).toBe(P.a)
      const seen: string[] = []
      let cursor: string | null = null
      const pages: number[] = []
      do {
        const page = await getParentOrdersPage(getPool(), { parentProfileId: profile! }, { cursor, limit: 2 })
        if (!page.ok) throw new Error("invalid cursor")
        pages.push(page.orders.length)
        seen.push(...page.orders.map((o) => o.id))
        if (page.orders.some((o) => o.id === order(1))) {
          const o1 = page.orders.find((o) => o.id === order(1))!
          expect(o1.completedAt).toBe("2026-09-02T10:00:00.345678+00:00")
          expect(o1.createdAt).toBe("2026-09-01T11:00:00.000001+00:00")
        }
        cursor = page.nextCursor
      } while (cursor)
      expect(pages).toEqual([2, 2, 1])
      expect(seen).toEqual([order(5), order(4), order(3), order(2), order(1)])
    })

    it("25. another parent's orders are never returned", async () => {
      const page = await getParentOrdersPage(getPool(), { parentProfileId: P.b }, { limit: 50 })
      if (!page.ok) throw new Error("invalid cursor")
      expect(page.orders.map((o) => o.id)).toEqual([order(7), order(6)])
      expect(page.orders.every((o) => o.completedAt === null)).toBe(true)
    })
  })
})

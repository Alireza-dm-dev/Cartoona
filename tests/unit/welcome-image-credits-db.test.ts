import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"

/**
 * REAL-SQL integration tests for V0.1.34 welcome image credits.
 *
 * These run the project's actual migration chain (with Supabase-managed pieces
 * stubbed by tests/helpers/supabase-stub.sql) on a throwaway LOCAL PostgreSQL
 * and call the real create_parent_request_trusted function, with genuinely
 * concurrent sessions for the race cases.
 *
 * Opt-in: set CARTOONA_LOCAL_PG="127.0.0.1:5432" (host:port of a local
 * Postgres you control; user "postgres", trust auth). Unset => the suite is
 * skipped, so `npm test` needs no database. Safety: only loopback hosts are
 * accepted, and the suite creates and drops its OWN uniquely named database -
 * it can never touch a hosted Supabase project.
 */

const run = promisify(execFile)
const target = process.env.CARTOONA_LOCAL_PG ?? ""
const [host, port] = target.split(":")
const enabled = target !== "" && (host === "127.0.0.1" || host === "localhost") && /^\d+$/.test(port ?? "")
if (target && !enabled) throw new Error("CARTOONA_LOCAL_PG must be a loopback host:port")

const DB = `cartoona_wic_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const root = process.cwd()
const SKIPPED_ON_EMPTY_DB = ["20260727121000", "20260727122000", "20260727123000"] // assert production row counts

async function psql(sql: string, opts: { db?: string; file?: string } = {}): Promise<string> {
  const args = ["-h", host, "-p", port, "-U", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", opts.db ?? DB]
  args.push(...(opts.file ? ["-f", opts.file] : ["-c", sql]))
  const { stdout } = await run("psql", args, { env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } })
  return stdout.trim()
}

/** Run SQL and return { ok, out, err } instead of throwing (constraint / RPC errors are expected data here). */
async function attempt(sql: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    return { ok: true, out: await psql(sql), err: "" }
  } catch (e) {
    const err = String((e as { stderr?: string }).stderr ?? e)
    return { ok: false, out: "", err }
  }
}

let counter = 0
const uuid = (): string => {
  counter += 1
  const hex = (Date.now() + counter).toString(16).padStart(12, "0").slice(-12)
  return `aaaaaaaa-0000-4000-8000-${hex}`
}

interface Parent { userId: string; profileId: string }

async function createParent(opts: { role?: string; candy?: number; deleted?: boolean } = {}): Promise<Parent> {
  const userId = uuid()
  await psql(`insert into auth.users (id, email) values ('${userId}', '${userId}@x.test')`)
  if (opts.role && opts.role !== "parent") await psql(`update public.users set role='${opts.role}' where id='${userId}'`)
  if (opts.deleted) await psql(`update public.users set deleted_at=now() where id='${userId}'`)
  const profileId = await psql(
    `insert into public.parent_profiles (user_id, consent_granted) values ('${userId}', true) returning id`,
  )
  if (opts.candy) await psql(`update public.candy_wallets set balance=${opts.candy} where parent_id='${profileId}'`)
  return { userId, profileId }
}

const credits = async (p: Parent) =>
  (await psql(`select granted_count||','||used_count from public.parent_welcome_credits where parent_id='${p.profileId}'`)) || "none"
const balance = async (p: Parent) => Number(await psql(`select balance from public.candy_wallets where parent_id='${p.profileId}'`))
const ledgerCount = async (p: Parent) =>
  Number(await psql(`select count(*) from public.candy_transactions t join public.candy_wallets w on w.id=t.wallet_id where w.parent_id='${p.profileId}'`))

let characterId = ""

interface SubmitOpts { type?: "image" | "video" | "drawing_animation"; key?: string | null; orderId?: string }

/** The exact RPC call the API route makes, as one SQL statement (one transaction). */
function submitSql(p: Parent, o: SubmitOpts = {}): string {
  const type = o.type ?? "image"
  const key = o.key === undefined ? uuid() : o.key
  const orderId = o.orderId ?? uuid()
  const video = type === "video"
  const anim = type === "drawing_animation"
  const file = anim ? `'${p.userId}/${orderId}/draw.png'` : "null"
  return `select id||'|'||type||'|'||candy_cost||'|'||replayed||'|'||payment_source from public.create_parent_request_trusted(
    '${p.profileId}', '${orderId}', '${type}', ${anim ? "'t'" : "null"}, null,
    ${anim ? "null" : `'${characterId}'`}, ${video || anim ? "'short'" : "null"},
    ${video ? "'script'" : "null"}, null, ${anim ? "'wave'" : "null"}, ${file}, ${video ? "'5_10'" : "null"},
    ${video ? "false" : "null"}, null, null, ${key === null ? "null" : `'${key}'`})`
}

interface Outcome { ok: boolean; id?: string; type?: string; cost?: number; replayed?: boolean; source?: string; error?: string }

async function submit(p: Parent, o: SubmitOpts = {}): Promise<Outcome> {
  if (o.type === "drawing_animation") {
    // The RPC verifies the uploaded object exists in storage.
    const orderId = (o.orderId ??= uuid())
    await psql(`insert into storage.objects (bucket_id, name, metadata) values ('parent-uploads', '${p.userId}/${orderId}/draw.png', '{"mimetype":"image/png"}') on conflict do nothing`)
  }
  const r = await attempt(submitSql(p, o))
  if (!r.ok) return { ok: false, error: /INSUFFICIENT_CANDIES/.test(r.err) ? "INSUFFICIENT_CANDIES" : r.err.slice(0, 200) }
  const [id, type, cost, replayed, source] = r.out.split("|")
  return { ok: true, id, type, cost: Number(cost), replayed: replayed === "true", source }
}

/**
 * Run `sqls` as truly simultaneous sessions. A controller session holds an
 * exclusive advisory lock; every worker blocks on a shared lock for it; once ALL
 * workers are provably waiting, the controller exits and they are released at the
 * same instant. Without this, serially spawned psql processes finish one RPC
 * before the next even connects and the "race" tests would not race.
 */
async function runSimultaneously(sqls: string[]): Promise<{ ok: boolean; out: string; err: string }[]> {
  const BARRIER = 7_770_001
  const base = ["-h", host, "-p", port, "-U", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", DB]
  const controller = spawn("psql", [...base, "-c", `select pg_advisory_lock(${BARRIER}); select pg_sleep(120)`], { stdio: "ignore" })
  const release = () =>
    psql(`select pg_terminate_backend(pid) from pg_locks where locktype='advisory' and objid=${BARRIER} and granted and mode='ExclusiveLock'`)
  const waitFor = async (sql: string, want: number) => {
    for (let i = 0; i < 400; i++) {
      if (Number(await psql(sql)) >= want) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`barrier condition not reached: ${sql}`)
  }
  try {
    await waitFor(`select count(*) from pg_locks where locktype='advisory' and objid=${BARRIER} and granted`, 1)
    const workers = sqls.map((sql) =>
      attempt(`select pg_advisory_lock_shared(${BARRIER}); ${sql}`).then((r) => ({ ...r, out: r.out.split("\n").pop() ?? "" })),
    )
    await waitFor(`select count(*) from pg_locks where locktype='advisory' and objid=${BARRIER} and not granted`, sqls.length)
    // Release everyone at once. Killing the client is not enough - a backend
    // sleeping in pg_sleep does not notice the disconnect - so end its session.
    await release()
    return await Promise.all(workers)
  } finally {
    controller.kill("SIGKILL")
    await release().catch(() => undefined)
  }
}

async function submitMany(p: Parent, n: number, o: () => SubmitOpts = () => ({})): Promise<Outcome[]> {
  const results = await runSimultaneously(Array.from({ length: n }, () => submitSql(p, o())))
  return results.map((r) => {
    if (!r.ok) return { ok: false, error: /INSUFFICIENT_CANDIES/.test(r.err) ? "INSUFFICIENT_CANDIES" : r.err.slice(0, 200) }
    const [id, type, cost, replayed, source] = r.out.split("|")
    return { ok: true, id, type, cost: Number(cost), replayed: replayed === "true", source }
  })
}

const orderCount = async (p: Parent) => Number(await psql(`select count(*) from public.orders where parent_id='${p.profileId}'`))
const usageCount = async (p: Parent) => Number(await psql(`select count(*) from public.parent_welcome_credit_usages where parent_id='${p.profileId}'`))

describe.skipIf(!enabled)("welcome image credits (real SQL, local Postgres)", () => {
  vi.setConfig({ testTimeout: 60_000 })
  beforeAll(async () => {
    await psql(`create database ${DB}`, { db: "postgres" })
    await psql("", { file: path.join(root, "tests/helpers/supabase-stub.sql") })
    const dir = path.join(root, "supabase/migrations")
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      if (SKIPPED_ON_EMPTY_DB.some((p) => f.startsWith(p))) continue
      await psql("", { file: path.join(dir, f) })
    }
    characterId = await psql("select id from public.characters where is_active limit 1")
  }, 180_000)

  afterAll(async () => {
    await psql(`drop database if exists ${DB} with (force)`, { db: "postgres" })
  })

  describe("one-time grant", () => {
    it("a new parent receives exactly 3, unused", async () => {
      const p = await createParent()
      expect(await credits(p)).toBe("3,0")
    })

    it("a second initialisation / profile upsert / repeated trigger gives no extra credits", async () => {
      const p = await createParent()
      const dup = await attempt(`insert into public.parent_profiles (user_id) values ('${p.userId}')`)
      expect(dup.ok).toBe(false) // one profile per user
      await psql(`insert into public.parent_profiles (user_id, full_name) values ('${p.userId}', 'x') on conflict (user_id) do update set full_name = excluded.full_name`)
      // Re-running the grant for the same parent is a no-op.
      await psql(`insert into public.parent_welcome_credits (parent_id) values ('${p.profileId}') on conflict (parent_id) do nothing`)
      expect(await credits(p)).toBe("3,0")
      expect(await psql(`select count(*) from public.parent_welcome_credits where parent_id='${p.profileId}'`)).toBe("1")
    })

    it("concurrent initialisation of the same account grants exactly once", async () => {
      const userId = uuid()
      await psql(`insert into auth.users (id, email) values ('${userId}', '${userId}@x.test')`)
      const results = await runSimultaneously(
        Array.from({ length: 10 }, () => `insert into public.parent_profiles (user_id, consent_granted) values ('${userId}', true)`),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      const profileId = await psql(`select id from public.parent_profiles where user_id='${userId}'`)
      expect(await psql(`select granted_count||','||used_count from public.parent_welcome_credits where parent_id='${profileId}'`)).toBe("3,0")
      expect(await psql(`select count(*) from public.parent_welcome_credits where parent_id='${profileId}'`)).toBe("1")
    })

    it("the unique key and the overspend guard are durable constraints", async () => {
      const p = await createParent()
      const dup = await attempt(`insert into public.parent_welcome_credits (parent_id) values ('${p.profileId}')`)
      expect(dup.ok).toBe(false)
      expect(dup.err).toMatch(/duplicate key|23505|unique/i)
      const over = await attempt(`update public.parent_welcome_credits set used_count = 4 where parent_id='${p.profileId}'`)
      expect(over.ok).toBe(false)
      expect(over.err).toMatch(/not_overspent|check constraint/i)
      const neg = await attempt(`update public.parent_welcome_credits set used_count = -1 where parent_id='${p.profileId}'`)
      expect(neg.ok).toBe(false)
    })

    it("admin accounts and soft-deleted users are not granted", async () => {
      const admin = await createParent({ role: "admin" })
      // An admin that somehow gets a profile row still receives no parent credit.
      expect(await credits(admin)).toBe("none")
    })
  })

  describe("existing-parent backfill (the exact SQL from the migration)", () => {
    const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260926100000_welcome_image_credits.sql"), "utf8")
    const backfill = migration.slice(
      migration.indexOf("INSERT INTO public.parent_welcome_credits (parent_id, granted_count, used_count)\nSELECT pp.id"),
      migration.indexOf("-- ═════════════════════════════════════════════════════════════════════════════\n-- 5."),
    )

    it("grants each eligible existing parent exactly one grant, regardless of candy balance; idempotent; skips admin/deleted", async () => {
      const rich = await createParent({ candy: 500 })
      const broke = await createParent()
      const used = await createParent()
      const admin = await createParent({ role: "admin" })
      const gone = await createParent({ deleted: true })
      // Simulate "existed before the migration": no grant row.
      await psql(`delete from public.parent_welcome_credits where parent_id in ('${rich.profileId}','${broke.profileId}','${used.profileId}','${admin.profileId}','${gone.profileId}')`)
      expect(backfill).toContain("ON CONFLICT (parent_id) DO NOTHING")

      await psql(backfill)
      expect(await credits(rich)).toBe("3,0")
      expect(await credits(broke)).toBe("3,0")
      expect(await credits(used)).toBe("3,0")
      expect(await credits(admin)).toBe("none")
      expect(await credits(gone)).toBe("none")

      // Re-running adds nothing, and never resets consumption.
      await psql(`update public.parent_welcome_credits set used_count = 2 where parent_id='${used.profileId}'`)
      await psql(backfill)
      await psql(backfill)
      expect(await credits(used)).toBe("3,2")
      expect(await credits(rich)).toBe("3,0")
      expect(await balance(rich)).toBe(500) // candy untouched by the grant
    })
  })

  describe("consumption", () => {
    it("images 1-3 use a welcome credit (even with 0 candy); the 4th falls back to candy", async () => {
      const p = await createParent({ candy: 12 })
      const r1 = await submit(p), r2 = await submit(p), r3 = await submit(p)
      for (const r of [r1, r2, r3]) expect(r).toMatchObject({ ok: true, source: "welcome_image_credit", cost: 0, replayed: false, type: "image" })
      expect(await credits(p)).toBe("3,3")
      expect(await balance(p)).toBe(12) // candy untouched

      const r4 = await submit(p)
      expect(r4).toMatchObject({ ok: true, source: "candy", cost: 12 })
      expect(await balance(p)).toBe(0)
      expect(await credits(p)).toBe("3,3") // never negative / never above the grant
    })

    it("an image with 0 candy succeeds while a credit exists; credit use writes no candy ledger row and moves no candy", async () => {
      const p = await createParent()
      expect(await balance(p)).toBe(0)
      const r = await submit(p)
      expect(r).toMatchObject({ ok: true, source: "welcome_image_credit", cost: 0 })
      expect(await ledgerCount(p)).toBe(0)
      expect(await balance(p)).toBe(0)
      expect(await usageCount(p)).toBe(1)
      expect(await psql(`select payment_source||','||candy_cost from public.orders where id='${r.id}'`)).toBe("welcome_image_credit,0")
      expect(await psql(`select count(*) from public.parent_welcome_credit_usages where order_id='${r.id}'`)).toBe("1")
    })

    it("a candy-paid order keeps the existing ledger behaviour", async () => {
      const p = await createParent({ candy: 30 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      const r = await submit(p)
      expect(r).toMatchObject({ ok: true, source: "candy", cost: 12 })
      expect(await balance(p)).toBe(18)
      expect(await ledgerCount(p)).toBe(1)
      expect(await psql(`select type||','||amount from public.candy_transactions t join public.candy_wallets w on w.id=t.wallet_id where w.parent_id='${p.profileId}'`)).toBe("order_debit,-12")
    })

    it("video cannot use a welcome credit: credits left + 0 candy => insufficient, credits untouched", async () => {
      const p = await createParent()
      const r = await submit(p, { type: "video" })
      expect(r).toMatchObject({ ok: false, error: "INSUFFICIENT_CANDIES" })
      expect(await credits(p)).toBe("3,0")
      expect(await orderCount(p)).toBe(0)
    })

    it("drawing animation cannot use a welcome credit", async () => {
      const p = await createParent()
      const r = await submit(p, { type: "drawing_animation" })
      expect(r).toMatchObject({ ok: false, error: "INSUFFICIENT_CANDIES" })
      expect(await credits(p)).toBe("3,0")
    })

    it("video / animation pay with candy even when credits remain, and leave credits untouched", async () => {
      const p = await createParent({ candy: 100 })
      const v = await submit(p, { type: "video" })
      const a = await submit(p, { type: "drawing_animation" })
      expect(v).toMatchObject({ ok: true, source: "candy", cost: 40 })
      expect(a).toMatchObject({ ok: true, source: "candy", cost: 35 })
      expect(await credits(p)).toBe("3,0")
      expect(await balance(p)).toBe(25)
    })

    it("the database itself refuses a welcome-credit video/animation order", async () => {
      const p = await createParent({ candy: 100 })
      const v = await submit(p, { type: "video" })
      const bad = await attempt(`update public.orders set payment_source='welcome_image_credit' where id='${v.id}'`)
      expect(bad.ok).toBe(false)
      expect(bad.err).toMatch(/image_only|check constraint/i)
    })

    it("zero credits + insufficient candy fails and creates nothing", async () => {
      const p = await createParent({ candy: 5 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      const r = await submit(p)
      expect(r).toMatchObject({ ok: false, error: "INSUFFICIENT_CANDIES" })
      expect(await orderCount(p)).toBe(0)
      expect(await balance(p)).toBe(5)
    })

    it("many sequential images never push the count past the grant or below zero", async () => {
      const p = await createParent({ candy: 24 })
      const results = []
      for (let i = 0; i < 8; i++) results.push(await submit(p))
      expect(results.filter((r) => r.source === "welcome_image_credit")).toHaveLength(3)
      expect(results.filter((r) => r.source === "candy")).toHaveLength(2)
      expect(results.filter((r) => !r.ok)).toHaveLength(3)
      expect(await credits(p)).toBe("3,3")
      expect(await balance(p)).toBe(0)
    })
  })

  describe("idempotency and concurrency", () => {
    it("same submission key x10 (concurrent): one order, one credit consumed, everyone gets the same answer", async () => {
      const p = await createParent()
      const key = uuid()
      const results = await submitMany(p, 10, () => ({ key }))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(new Set(results.map((r) => r.id)).size).toBe(1)
      expect(results.filter((r) => r.replayed === false)).toHaveLength(1)
      expect(results.filter((r) => r.replayed === true)).toHaveLength(9)
      expect(new Set(results.map((r) => r.source))).toEqual(new Set(["welcome_image_credit"]))
      expect(await orderCount(p)).toBe(1)
      expect(await credits(p)).toBe("3,1")
      expect(await usageCount(p)).toBe(1)
    })

    it("same key x10 with ONE credit and 0 candy: losers replay instead of failing 'insufficient'", async () => {
      const p = await createParent()
      await psql(`update public.parent_welcome_credits set used_count = 2 where parent_id='${p.profileId}'`)
      const key = uuid()
      const results = await submitMany(p, 10, () => ({ key }))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(results.filter((r) => r.replayed === false)).toHaveLength(1)
      expect(await credits(p)).toBe("3,3")
      expect(await orderCount(p)).toBe(1)
    })

    it("same key x10 on the candy path: one order, exactly one debit, one ledger row", async () => {
      const p = await createParent({ candy: 12 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      const key = uuid()
      const results = await submitMany(p, 10, () => ({ key }))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(results.filter((r) => r.replayed === false)).toHaveLength(1)
      expect(await balance(p)).toBe(0)
      expect(await ledgerCount(p)).toBe(1)
      expect(await orderCount(p)).toBe(1)
    })

    it("5 concurrent UNIQUE image requests with 3 credits and 0 candy: exactly 3 succeed, 2 fail", async () => {
      const p = await createParent()
      const results = await submitMany(p, 5)
      expect(results.filter((r) => r.ok)).toHaveLength(3)
      expect(results.filter((r) => !r.ok && r.error === "INSUFFICIENT_CANDIES")).toHaveLength(2)
      expect(results.filter((r) => r.ok).every((r) => r.source === "welcome_image_credit")).toBe(true)
      expect(await credits(p)).toBe("3,3")
      expect(await orderCount(p)).toBe(3)
      expect(await usageCount(p)).toBe(3)
      expect(await ledgerCount(p)).toBe(0)
    })

    it("mixed: 1 credit + candy for 2 images, 3 concurrent => all succeed, no double spend", async () => {
      const p = await createParent({ candy: 24 })
      await psql(`update public.parent_welcome_credits set used_count = 2 where parent_id='${p.profileId}'`)
      const results = await submitMany(p, 3)
      expect(results.every((r) => r.ok)).toBe(true)
      expect(results.filter((r) => r.source === "welcome_image_credit")).toHaveLength(1)
      expect(results.filter((r) => r.source === "candy")).toHaveLength(2)
      expect(await credits(p)).toBe("3,3")
      expect(await balance(p)).toBe(0)
      expect(await ledgerCount(p)).toBe(2)
    })

    it("mixed with one request too many: 4 concurrent => exactly 3 succeed, 1 insufficient, balances exact", async () => {
      const p = await createParent({ candy: 24 })
      await psql(`update public.parent_welcome_credits set used_count = 2 where parent_id='${p.profileId}'`)
      const results = await submitMany(p, 4)
      expect(results.filter((r) => r.ok)).toHaveLength(3)
      expect(results.filter((r) => !r.ok)).toHaveLength(1)
      expect(await balance(p)).toBe(0)
      expect(await credits(p)).toBe("3,3")
    })

    it("different parents never share credits under concurrency", async () => {
      const a = await createParent(), b = await createParent()
      const all = await runSimultaneously([...Array(4)].flatMap(() => [submitSql(a), submitSql(b)]))
      expect(all.filter((r) => r.ok)).toHaveLength(6)
      expect(await credits(a)).toBe("3,3")
      expect(await credits(b)).toBe("3,3")
    })

    it("a replay reports the ORIGINAL payment source even after credits run out", async () => {
      const p = await createParent({ candy: 100 })
      const key = uuid()
      const first = await submit(p, { key })
      expect(first.source).toBe("welcome_image_credit")
      await submit(p); await submit(p) // credits now 0
      const replay = await submit(p, { key })
      expect(replay).toMatchObject({ ok: true, replayed: true, id: first.id, source: "welcome_image_credit", cost: 0 })
      expect(await balance(p)).toBe(100)

      // And a candy-paid original stays candy on replay.
      const key2 = uuid()
      const paid = await submit(p, { key: key2 })
      expect(paid.source).toBe("candy")
      expect(await submit(p, { key: key2 })).toMatchObject({ replayed: true, source: "candy", id: paid.id })
      expect(await balance(p)).toBe(88)
    })

    it("a failed request does not consume a credit: validation failure and a rolled-back transaction", async () => {
      const p = await createParent()
      // Fails inside the function (image must not carry a duration).
      const bad = await attempt(`select * from public.create_parent_request_trusted('${p.profileId}', '${uuid()}', 'image', null, null, '${characterId}', 'short', null, null, null, null, null, null, null, null, '${uuid()}')`)
      expect(bad.ok).toBe(false)
      expect(await credits(p)).toBe("3,0")

      // A fully successful call whose surrounding transaction is rolled back leaves nothing behind.
      await psql(`begin; ${submitSql(p)}; rollback;`)
      expect(await credits(p)).toBe("3,0")
      expect(await orderCount(p)).toBe(0)
      expect(await usageCount(p)).toBe(0)

      // The credit is still fully usable afterwards.
      expect(await submit(p)).toMatchObject({ ok: true, source: "welcome_image_credit" })
    })
  })

  describe("access control", () => {
    async function asParent(p: Parent, sql: string) {
      return attempt(`begin; set local role authenticated; set local request.jwt.claim.sub = '${p.userId}'; ${sql}; commit;`)
    }

    it("a parent can read their own credits and cannot see another parent's", async () => {
      const a = await createParent(), b = await createParent()
      const own = await asParent(a, `select count(*) from public.parent_welcome_credits where parent_id='${a.profileId}'`)
      expect(own.out.split("\n").filter((l) => /^\d+$/.test(l))).toEqual(["1"])
      const other = await asParent(a, `select count(*) from public.parent_welcome_credits where parent_id='${b.profileId}'`)
      expect(other.out.split("\n").filter((l) => /^\d+$/.test(l))).toEqual(["0"])
    })

    it("a parent cannot grant, edit or delete credits or usage rows from a browser session", async () => {
      const a = await createParent()
      for (const sql of [
        `update public.parent_welcome_credits set used_count = 0 where parent_id='${a.profileId}'`,
        `insert into public.parent_welcome_credits (parent_id) values ('${uuid()}')`,
        `delete from public.parent_welcome_credits where parent_id='${a.profileId}'`,
        `insert into public.parent_welcome_credit_usages (parent_id, order_id) values ('${a.profileId}', '${uuid()}')`,
      ]) {
        const r = await asParent(a, sql)
        expect(r.ok, sql).toBe(false)
        expect(r.err).toMatch(/permission denied/i)
      }
      expect(await credits(a)).toBe("3,0")
    })

    it("browser roles cannot call the trusted request RPC", async () => {
      const a = await createParent()
      const r = await asParent(a, `select * from public.create_parent_request_trusted('${a.profileId}', '${uuid()}', 'image', null, null, '${characterId}', null,null,null,null,null,null,null,null,null, '${uuid()}')`)
      expect(r.ok).toBe(false)
      expect(r.err).toMatch(/permission denied/i)
    })
  })
})

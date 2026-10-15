import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import path from "node:path"
import { withPgClusterLock } from "../helpers/pg-cluster-lock"
import { closePool, getPool } from "@/lib/db/pool"
import { withTransaction } from "@/lib/db/transaction"
import { DbError, normalizePgError } from "@/lib/db/errors"
import { pingDatabase } from "@/lib/db/health"
import { runQuery } from "@/lib/db/query"
import { getParentOrdersPage } from "@/lib/repositories/parent-orders"
import { getActiveCreationPrices } from "@/lib/repositories/creation-pricing"
import { getWelcomeImageCreditsRemaining } from "@/lib/repositories/welcome-credits"
import { getCandyBalance } from "@/lib/repositories/candy-wallets"
import { getUserById } from "@/lib/repositories/users"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import { RepositoryInputError } from "@/lib/repositories/actor"
import { decodeOrdersCursor, encodeOrdersCursor } from "@/lib/parent/orders/pagination"

/**
 * REAL-SQL tests for the V0.1.39 data-access layer.
 *
 * Opt-in, like plain-postgres-db.test.ts: CARTOONA_PLAIN_PG=docker against the
 * compose `postgres` service. Unset => skipped.
 *
 * Setup, all inside the LOCAL container:
 *  1. a uniquely named database dal_<id>, built by the real runner (0001-0009);
 *  2. a uniquely named login role cartoona_app_t<id>, created by the real
 *     scripts/db/app-login-role.sh as a member of cartoona_app, with a random
 *     password generated here;
 *  3. the REAL lib/db pool, from the host over the published loopback port,
 *     connected AS THAT ROLE - so every repository runs with exactly the
 *     application's privileges, not the owner's.
 * Fixtures are written as the owner through `docker exec`. The database and
 * the role are dropped afterwards. Nothing reads .env files or contacts any
 * hosted service.
 */

const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const run = promisify(execFile)
const root = process.cwd()
const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`
const DB = `dal_${id}`
const ROLE = `cartoona_app_t${id}`
const PASSWORD = randomBytes(24).toString("base64url")
let container = ""

async function owner(sql: string, db = DB): Promise<string> {
  const { stdout } = await run("docker", [
    "exec", "-i", container, "psql", "-U", "cartoona", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db,
    "-c", "SET client_min_messages = warning", "-c", sql,
  ])
  return stdout.trim()
}

function script(file: string, env: Record<string, string>, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(root, file), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PSQL: path.join(root, "scripts/db/psql-docker.sh"), CARTOONA_PG_CONTAINER: container, NODE_ENV: "test", ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }))
  })
}

const ownerUrl = `postgresql://cartoona@postgres:5432/${DB}`

async function createParent(): Promise<{ userId: string; profileId: string }> {
  const userId = await owner(`insert into public.users (id, email, role) values (gen_random_uuid(), 'p${randomBytes(4).toString("hex")}@x.test', 'parent') returning id`)
  const profileId = await owner(`insert into public.parent_profiles (user_id, consent_granted) values ('${userId}', true) returning id`)
  return { userId, profileId }
}

/** The oracle: visible order ids for a parent in (created_at DESC, id DESC) order, computed by the owner. */
async function expectedOrderIds(profileId: string): Promise<string[]> {
  const out = await owner(`select id from public.orders where parent_id='${profileId}' and status not in ('draft','pending_payment') order by created_at desc, id desc`)
  return out ? out.split("\n") : []
}

async function walk(profileId: string, limit?: number) {
  const pages: string[][] = []
  let cursor: string | null = null
  for (let i = 0; i < 100; i++) {
    const page = await getParentOrdersPage(getPool(), { parentProfileId: profileId }, { cursor, limit })
    if (!page.ok) throw new Error(page.reason)
    pages.push(page.orders.map((o) => o.id))
    cursor = page.nextCursor
    if (!cursor) break
  }
  return pages
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

let A: { userId: string; profileId: string }
let B: { userId: string; profileId: string }
let C: { userId: string; profileId: string }
let deliveredOrderId = ""

describe.skipIf(!enabled)("PostgreSQL data-access layer (real SQL, local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 60_000 })

  beforeAll(async () => {
    container = (await run("docker", ["compose", "ps", "-q", "postgres"], { cwd: root })).stdout.trim()
    if (!container) throw new Error("compose postgres service is not running: docker compose up -d postgres")
    await owner(`create database ${DB}`, "postgres")

    const migrated = await withPgClusterLock(() => script("scripts/db/migrate-local.sh", { DATABASE_URL: ownerUrl }))
    expect(migrated.stdout).toMatch(/done - 9 applied/)

    const login = await script("scripts/db/app-login-role.sh", { DATABASE_URL: ownerUrl, CARTOONA_APP_DB_PASSWORD: PASSWORD }, [ROLE])
    expect(login.code).toBe(0)
    expect(login.stdout + login.stderr).not.toContain(PASSWORD)

    // Fixtures (owner). A: 55 visible orders in tie groups of 5 sharing one
    // microsecond timestamp, plus 2 newer hidden ones. B: 5 orders. C: none.
    A = await createParent()
    B = await createParent()
    C = await createParent()
    await owner(`
      insert into public.orders (parent_id, type, status, title, candy_cost, created_at)
      select '${A.profileId}',
             (array['image','video','drawing_animation'])[1 + i % 3],
             (array['pending_review','in_progress','ready','delivered','rejected','cancelled'])[1 + i % 6],
             'A order ' || i, 10 + i,
             timestamptz '2026-01-01 00:00:00.000001+00' + (i / 5) * interval '1.234567 second'
      from generate_series(1, 55) i`)
    await owner(`
      insert into public.orders (parent_id, type, status, title, created_at) values
        ('${A.profileId}', 'image', 'draft', 'hidden draft', '2027-01-01T00:00:00Z'),
        ('${A.profileId}', 'image', 'pending_payment', 'hidden pending', '2027-01-02T00:00:00Z')`)
    await owner(`
      insert into public.orders (parent_id, type, status, title, created_at)
      select '${B.profileId}', 'image', 'pending_review', 'B order ' || i, timestamptz '2026-01-01 00:00:05+00' + i * interval '1 second'
      from generate_series(1, 5) i`)
    deliveredOrderId = await owner(`select id from public.orders where parent_id='${A.profileId}' and status='delivered' order by created_at desc limit 1`)
    await owner(`
      insert into public.order_status_history (order_id, previous_status, new_status, created_at) values
        ('${deliveredOrderId}', 'ready', 'delivered', '2026-03-01T10:00:00.654321Z'),
        ('${deliveredOrderId}', 'ready', 'delivered', '2026-03-05T10:00:00Z')`)

    // The real pool module, as the login role, over the published port.
    const port = (await run("docker", ["compose", "port", "postgres", "5432"], { cwd: root })).stdout.trim().split(":").pop()
    vi.stubEnv("DATABASE_URL", `postgresql://${ROLE}:${PASSWORD}@127.0.0.1:${port}/${DB}`)
    vi.stubEnv("DB_POOL_MAX", "4")
  }, 180_000)

  afterAll(async () => {
    await closePool()
    vi.unstubAllEnvs()
    if (!container) return
    await owner(`drop database if exists ${DB} with (force)`, "postgres")
    await owner(`drop role if exists ${ROLE}`, "postgres")
  })

  describe("foundation", () => {
    it("ping succeeds and the session is the least-privilege login role", async () => {
      const ping = await pingDatabase()
      expect(ping.ok).toBe(true)
      const [who] = await runQuery<{ current_user: string; rolsuper: boolean; member: boolean }>(getPool(),
        "SELECT current_user, r.rolsuper, pg_has_role(current_user, 'cartoona_app', 'USAGE') AS member FROM pg_roles r WHERE r.rolname = current_user")
      expect(who).toEqual({ current_user: ROLE, rolsuper: false, member: true })
    })

    it("one pool is reused across calls and every client is returned", async () => {
      const pool = getPool()
      await Promise.all(Array.from({ length: 12 }, () => runQuery(pool, "SELECT pg_sleep(0.01)")))
      expect(getPool()).toBe(pool)
      expect(pool.totalCount).toBeLessThanOrEqual(4)
      expect(pool.waitingCount).toBe(0)
      expect(pool.idleCount).toBe(pool.totalCount)
    })

    describe("transactions and error normalisation (on a test-only table)", () => {
      beforeAll(async () => {
        await owner(`
          create table public.dal_probe (id int primary key, n int not null check (n >= 0), parent_id uuid references public.parent_profiles(id));
          grant select, insert on public.dal_probe to ${ROLE};
          create function public.dal_raise() returns void language plpgsql as $$ begin raise exception 'request_not_found'; end $$;
          grant execute on function public.dal_raise() to ${ROLE};`)
      })

      it("commits", async () => {
        await withTransaction(async (tx) => {
          await tx.query("INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [1, 1])
        })
        expect(await owner("select count(*) from public.dal_probe where id = 1")).toBe("1")
      })

      it("rolls back every statement on error and rethrows the original", async () => {
        const original = new Error("abort after insert")
        await expect(withTransaction(async (tx) => {
          await tx.query("INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [2, 1])
          await tx.query("INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [3, 1])
          throw original
        })).rejects.toBe(original)
        expect(await owner("select count(*) from public.dal_probe where id in (2, 3)")).toBe("0")
        expect(getPool().idleCount).toBe(getPool().totalCount)
      })

      it("a constraint failure inside a transaction rolls back the earlier writes", async () => {
        const error = await withTransaction(async (tx) => {
          await tx.query("INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [4, 1])
          await tx.query("INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [1, 1]) // duplicate
        }).catch((e: unknown) => e)
        expect((normalizePgError(error) as DbError).kind).toBe("unique_violation")
        expect(await owner("select count(*) from public.dal_probe where id = 4")).toBe("0")
      })

      it.each([
        ["INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [1, 1], "unique_violation", "dal_probe_pkey"],
        ["INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [10, -1], "check_violation", "dal_probe_n_check"],
        ["INSERT INTO public.dal_probe (id, n, parent_id) VALUES ($1, $2, $3)", [11, 1, "99999999-9999-4999-8999-999999999999"], "foreign_key_violation", "dal_probe_parent_id_fkey"],
        ["INSERT INTO public.dal_probe (id, n) VALUES ($1, $2)", [12, null], "not_null_violation", null],
        ["SELECT $1::uuid", ["not-a-uuid"], "invalid_input", null],
      ] as const)("%s %j -> %s", async (sql, values, kind, constraint) => {
        const error = await runQuery(getPool(), sql, values).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(DbError)
        expect((error as DbError).kind).toBe(kind)
        if (constraint) expect((error as DbError).constraint).toBe(constraint)
        expect((error as Error).message).toBe(`database error: ${kind}`)
      })

      it("a business token raised by a SQL function is recognised", async () => {
        const error = await runQuery(getPool(), "SELECT public.dal_raise()").catch((e: unknown) => e)
        expect(error).toMatchObject({ kind: "business", businessCode: "request_not_found", sqlState: "P0001" })
      })
    })
  })

  describe("application role privileges", () => {
    it.each([
      ["write a granted table", "INSERT INTO public.creation_pricing (pricing_key, candy_cost) VALUES ('x', 1)"],
      ["update an order", "UPDATE public.orders SET title = 'x'"],
      ["delete history", "DELETE FROM public.order_status_history"],
      ["read an ungranted table", "SELECT 1 FROM public.candy_transactions LIMIT 1"],
      ["read the migration ledger", "SELECT 1 FROM public.schema_migrations LIMIT 1"],
      ["create in public", "CREATE TABLE public.dal_x (x int)"],
      ["drop a table", "DROP TABLE public.orders"],
      ["alter a table", "ALTER TABLE public.orders DISABLE TRIGGER ALL"],
      ["bypass triggers", "SET session_replication_role = replica"],
      ["call a trusted function", "SELECT public.get_parent_orders_delivered_at_trusted(gen_random_uuid(), ARRAY[]::uuid[])"],
    ])("cannot %s", async (_label, sql) => {
      const error = await runQuery(getPool(), sql).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DbError)
      expect((error as DbError).sqlState).toBe("42501")
    })

    it("the group role has no login, no special attributes, and owns nothing", async () => {
      expect(await owner("select rolcanlogin||','||rolsuper||','||rolcreatedb||','||rolcreaterole||','||rolreplication||','||rolbypassrls from pg_roles where rolname='cartoona_app'"))
        .toBe("false,false,false,false,false,false")
      expect(await owner("select count(*) from pg_class c join pg_roles r on r.oid=c.relowner where r.rolname like 'cartoona_app%'")).toBe("0")
    })
  })

  describe("creation pricing (public read)", () => {
    it("matches the seeded catalog", async () => {
      const expected = Object.fromEntries(
        (await owner("select pricing_key||'='||candy_cost from public.creation_pricing where is_active order by 1"))
          .split("\n").map((l) => { const [k, v] = l.split("="); return [k, Number(v)] }),
      )
      const result = await getActiveCreationPrices(getPool())
      expect(result).toEqual({ ok: true, prices: expected })
      expect(Object.keys(expected)).toHaveLength(9)
      expect(expected["image.default"]).toBe(12)
    })

    it("inactive rows are excluded; an empty catalog is invalid", async () => {
      await owner("update public.creation_pricing set is_active = false where pricing_key = 'video.long'")
      const partial = await getActiveCreationPrices(getPool())
      expect(partial.ok && Object.keys(partial.prices)).not.toContain("video.long")
      await owner("update public.creation_pricing set is_active = false")
      expect(await getActiveCreationPrices(getPool())).toEqual({ ok: false, reason: "invalid_catalog" })
      await owner("update public.creation_pricing set is_active = true")
    })
  })

  describe("welcome credits, wallet, users, profiles", () => {
    it("a new parent has the 3-credit grant; the count follows used_count and never goes negative", async () => {
      const p = await createParent()
      expect(await getWelcomeImageCreditsRemaining(getPool(), { parentProfileId: p.profileId })).toBe(3)
      await owner(`update public.parent_welcome_credits set used_count = 2 where parent_id = '${p.profileId}'`)
      expect(await getWelcomeImageCreditsRemaining(getPool(), { parentProfileId: p.profileId })).toBe(1)
      await owner(`update public.parent_welcome_credits set used_count = 3 where parent_id = '${p.profileId}'`)
      expect(await getWelcomeImageCreditsRemaining(getPool(), { parentProfileId: p.profileId })).toBe(0)
    })

    it("each parent reads only their own credits; an unknown parent has 0", async () => {
      await owner(`update public.parent_welcome_credits set used_count = 1 where parent_id = '${B.profileId}'`)
      expect(await getWelcomeImageCreditsRemaining(getPool(), { parentProfileId: A.profileId })).toBe(3)
      expect(await getWelcomeImageCreditsRemaining(getPool(), { parentProfileId: B.profileId })).toBe(2)
      expect(await getWelcomeImageCreditsRemaining(getPool(), { parentProfileId: "99999999-9999-4999-8999-999999999999" })).toBe(0)
    })

    it("wallet balance per parent; null without a wallet", async () => {
      await owner(`update public.candy_wallets set balance = 40 where parent_id = '${A.profileId}'`)
      expect(await getCandyBalance(getPool(), { parentProfileId: A.profileId })).toBe(40)
      expect(await getCandyBalance(getPool(), { parentProfileId: B.profileId })).toBe(0)
      expect(await getCandyBalance(getPool(), { parentProfileId: "99999999-9999-4999-8999-999999999999" })).toBeNull()
    })

    it("user role and profile id resolve by explicit id", async () => {
      expect(await getUserById(getPool(), { userId: A.userId })).toEqual({ id: A.userId, role: "parent", deleted: false })
      expect(await findParentProfileIdByUserId(getPool(), { userId: A.userId })).toBe(A.profileId)
      expect(await findParentProfileIdByUserId(getPool(), { userId: B.userId })).toBe(B.profileId)
      expect(await getUserById(getPool(), { userId: "99999999-9999-4999-8999-999999999999" })).toBeNull()
    })
  })

  describe("parent orders", () => {
    it("default walk: pages of 20/20/15, exact (created_at DESC, id DESC) order, no duplicates, no gaps", async () => {
      const pages = await walk(A.profileId)
      expect(pages.map((p) => p.length)).toEqual([20, 20, 15])
      const all = pages.flat()
      expect(new Set(all).size).toBe(all.length)
      expect(all).toEqual(await expectedOrderIds(A.profileId))
    })

    it("pages that split a tie group of identical timestamps still neither repeat nor skip", async () => {
      for (const size of [1, 2, 3, 7]) {
        const all = (await walk(A.profileId, size)).flat()
        expect(all).toEqual(await expectedOrderIds(A.profileId))
      }
    })

    it("hidden statuses never appear, even though they are the newest rows", async () => {
      const page = await getParentOrdersPage(getPool(), { parentProfileId: A.profileId })
      expect(page.ok && page.orders.map((o) => o.displayTitle)).not.toEqual(expect.arrayContaining(["hidden draft"]))
      expect(page.ok && page.orders[0].displayTitle).not.toMatch(/hidden/)
    })

    it("page size bounds: max 50, default for invalid input", async () => {
      const big = await getParentOrdersPage(getPool(), { parentProfileId: A.profileId }, { limit: 1000 })
      expect(big.ok && big.orders).toHaveLength(50)
      expect(big.ok && big.nextCursor).not.toBeNull()
      const zero = await getParentOrdersPage(getPool(), { parentProfileId: A.profileId }, { limit: 0 })
      expect(zero.ok && zero.orders).toHaveLength(20)
    })

    it("completedAt is the FIRST delivered transition, with full precision; others are null", async () => {
      const all = (await walk(A.profileId, 50)).flat()
      expect(all).toContain(deliveredOrderId)
      const pages: Array<{ id: string; completedAt: string | null; status: string }> = []
      let cursor: string | null = null
      do {
        const page = await getParentOrdersPage(getPool(), { parentProfileId: A.profileId }, { cursor, limit: 50 })
        if (!page.ok) throw new Error("unexpected")
        pages.push(...page.orders)
        cursor = page.nextCursor
      } while (cursor)
      const delivered = pages.find((o) => o.id === deliveredOrderId)
      expect(delivered).toMatchObject({ status: "ready", completedAt: "2026-03-01T10:00:00.654321+00:00" })
      expect(pages.filter((o) => o.completedAt !== null)).toHaveLength(1)
    })

    it("cursor timestamps keep microseconds and round-trip", async () => {
      const page = await getParentOrdersPage(getPool(), { parentProfileId: A.profileId }, { limit: 3 })
      const cursor = page.ok ? decodeOrdersCursor(page.nextCursor) : null
      expect(cursor?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/)
      expect(page.ok && page.orders[0].createdAt).toMatch(/\.\d{6}\+00:00$/)
    })

    it("ownership: a parent sees only their own orders, and another parent's cursor grants nothing", async () => {
      const bOrders = (await walk(B.profileId)).flat()
      expect(bOrders).toEqual(await expectedOrderIds(B.profileId))
      expect(bOrders).toHaveLength(5)
      const aIds = new Set(await expectedOrderIds(A.profileId))
      expect(bOrders.some((x) => aIds.has(x))).toBe(false)

      // A cursor minted from A's page, replayed with B's identity.
      const aPage = await getParentOrdersPage(getPool(), { parentProfileId: A.profileId }, { limit: 2 })
      const replay = await getParentOrdersPage(getPool(), { parentProfileId: B.profileId }, { cursor: aPage.ok ? aPage.nextCursor : null })
      expect(replay.ok && replay.orders.every((o) => !aIds.has(o.id))).toBe(true)

      // A forged, well-formed cursor naming one of A's order ids.
      const aFirst = [...aIds][0]
      const forged = encodeOrdersCursor({ createdAt: "2099-01-01T00:00:00.000000+00:00", id: aFirst })
      const forgedPage = await getParentOrdersPage(getPool(), { parentProfileId: B.profileId }, { cursor: forged })
      expect(forgedPage.ok && forgedPage.orders.map((o) => o.id)).toEqual(bOrders)
    })

    it("empty state: a parent with no orders", async () => {
      expect(await getParentOrdersPage(getPool(), { parentProfileId: C.profileId })).toEqual({ ok: true, orders: [], nextCursor: null })
    })

    it("hostile inputs stay inert: rejected before SQL, and the schema is intact", async () => {
      await expect(getParentOrdersPage(getPool(), { parentProfileId: `${A.profileId}' OR '1'='1` })).rejects.toBeInstanceOf(RepositoryInputError)
      const bad = Buffer.from(`2026-01-01T00:00:00Z|${A.profileId}'); DROP TABLE public.orders; --`).toString("base64url")
      expect(await getParentOrdersPage(getPool(), { parentProfileId: A.profileId }, { cursor: bad })).toEqual({ ok: false, reason: "invalid_cursor" })
      // Hostile text stored as data comes back as data.
      const hostile = "'); DROP TABLE public.orders; --"
      await owner(`update public.orders set title = $t$${hostile}$t$ where parent_id = '${B.profileId}'`)
      const bPage = await getParentOrdersPage(getPool(), { parentProfileId: B.profileId })
      expect(bPage.ok && bPage.orders.every((o) => o.displayTitle === hostile)).toBe(true)
      expect(await owner("select count(*) from public.orders")).toBe("62")
    })
  })

  describe("local timings (informational)", () => {
    it("median of repeated reads through the pool", async () => {
      const pool = getPool()
      const cases: Array<[string, () => Promise<unknown>]> = [
        ["SELECT 1", () => pingDatabase()],
        ["creation pricing", () => getActiveCreationPrices(pool)],
        ["welcome credits", () => getWelcomeImageCreditsRemaining(pool, { parentProfileId: A.profileId })],
        ["parent orders, first page (20 of 55)", () => getParentOrdersPage(pool, { parentProfileId: A.profileId })],
      ]
      const report: Record<string, string> = {}
      for (const [label, fn] of cases) {
        for (let i = 0; i < 10; i++) await fn() // warm the pool and plan cache
        const samples: number[] = []
        for (let i = 0; i < 200; i++) {
          const t = performance.now()
          await fn()
          samples.push(performance.now() - t)
        }
        const sorted = [...samples].sort((a, b) => a - b)
        report[label] = `median ${median(samples).toFixed(2)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(2)} ms`
        expect(median(samples)).toBeLessThan(250)
      }
      process.stderr.write("[db timings, local Docker PostgreSQL 17, 200 calls each]\n" + Object.entries(report).map(([k, v]) => `  ${k}: ${v}`).join("\n") + "\n")
    })
  })
})

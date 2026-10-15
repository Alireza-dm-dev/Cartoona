import { describe, it, expect } from "vitest"
import type { Queryable } from "@/lib/db/types"
import { DbError } from "@/lib/db/errors"
import { encodeOrdersCursor } from "@/lib/parent/orders/pagination"
import { getParentOrdersPage } from "@/lib/repositories/parent-orders"
import { getActiveCreationPrices } from "@/lib/repositories/creation-pricing"
import { getWelcomeImageCreditsRemaining } from "@/lib/repositories/welcome-credits"
import { getCandyBalance } from "@/lib/repositories/candy-wallets"
import { getUserById } from "@/lib/repositories/users"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import { RepositoryInputError } from "@/lib/repositories/actor"

/**
 * Repository logic against a recording fake `Queryable`: what SQL is sent,
 * with which bind values, and how rows map back. Real-SQL behaviour is in the
 * opt-in postgres-repositories-db.test.ts.
 */

interface Call { text: string; values: readonly unknown[] }

function fakeDb(rows: Record<string, unknown>[] | ((call: Call) => Record<string, unknown>[]) = []) {
  const calls: Call[] = []
  const db: Queryable = {
    async query(text: string, values: readonly unknown[] = []) {
      const call = { text, values }
      calls.push(call)
      const out = typeof rows === "function" ? rows(call) : rows
      return { rows: out, rowCount: out.length, command: "SELECT", oid: 0, fields: [] } as never
    },
  }
  return { db, calls }
}

function failingDb(code: string): Queryable {
  return {
    async query() {
      throw Object.assign(new Error(`raw failure ${code} for row (secret)`), { code })
    },
  }
}

const PARENT = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"

const DANGEROUS = [
  "' OR '1'='1",
  "x'; DROP TABLE public.orders; --",
  "11111111-1111-4111-8111-111111111111' OR parent_id IS NOT NULL --",
  "$1",
  "\\'",
  "",
]

function orderRow(i: number, extra: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
  return {
    id,
    type: "image",
    status: "pending_review",
    title: `order ${i}`,
    candy_cost: 12,
    created_at: `2026-01-01T00:00:${String(59 - (i % 60)).padStart(2, "0")}.123456+00:00`,
    delivered_at: null,
    ...extra,
  }
}

describe("parameterised SQL only", () => {
  it("the SQL text is constant; ids and cursors travel only as bind values", async () => {
    const { db, calls } = fakeDb([])
    const cursor = encodeOrdersCursor({ createdAt: "2026-01-01T00:00:00.123456+00:00", id: OTHER })
    await getParentOrdersPage(db, { parentProfileId: PARENT })
    await getParentOrdersPage(db, { parentProfileId: OTHER }, { cursor, limit: 5 })
    expect(calls).toHaveLength(2)
    expect(calls[0].text).toBe(calls[1].text)
    for (const call of calls) {
      expect(call.text).not.toContain(PARENT)
      expect(call.text).not.toContain(OTHER)
      expect(call.text).not.toContain("2026-01-01")
      expect(call.text).toMatch(/\$1/)
    }
    expect(calls[1].values).toEqual([
      OTHER,
      ["pending_review", "in_progress", "ready", "delivered", "rejected", "cancelled"],
      "2026-01-01T00:00:00.123456+00:00",
      OTHER,
      6,
    ])
  })

  it.each(DANGEROUS)("an actor id of %j is rejected before any SQL runs", async (bad) => {
    const { db, calls } = fakeDb([])
    await expect(getParentOrdersPage(db, { parentProfileId: bad })).rejects.toBeInstanceOf(RepositoryInputError)
    await expect(getWelcomeImageCreditsRemaining(db, { parentProfileId: bad })).rejects.toBeInstanceOf(RepositoryInputError)
    await expect(getCandyBalance(db, { parentProfileId: bad })).rejects.toBeInstanceOf(RepositoryInputError)
    await expect(getUserById(db, { userId: bad })).rejects.toBeInstanceOf(RepositoryInputError)
    await expect(findParentProfileIdByUserId(db, { userId: bad })).rejects.toBeInstanceOf(RepositoryInputError)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ...DANGEROUS.filter((c) => c !== ""),
    Buffer.from("2026-01-01T00:00:00Z' OR 1=1 --|" + OTHER).toString("base64url"),
    Buffer.from("2026-01-01T00:00:00Z|" + OTHER + "' OR 1=1").toString("base64url"),
    Buffer.from("now()|" + OTHER).toString("base64url"),
  ])("a cursor of %j is invalid_cursor and runs no SQL", async (bad) => {
    const { db, calls } = fakeDb([])
    expect(await getParentOrdersPage(db, { parentProfileId: PARENT }, { cursor: bad })).toEqual({ ok: false, reason: "invalid_cursor" })
    expect(calls).toHaveLength(0)
  })

  it("every repository sends constant text with values as parameters", async () => {
    const { db, calls } = fakeDb([])
    await getWelcomeImageCreditsRemaining(db, { parentProfileId: PARENT })
    await getCandyBalance(db, { parentProfileId: PARENT })
    await getUserById(db, { userId: PARENT })
    await findParentProfileIdByUserId(db, { userId: PARENT })
    await getActiveCreationPrices(db)
    for (const call of calls) expect(call.text).not.toContain(PARENT)
    expect(calls.map((c) => c.values)).toEqual([[PARENT], [PARENT], [PARENT], [PARENT], []])
  })
})

describe("parent orders page", () => {
  it.each([
    [undefined, 21],
    [20, 21],
    [1, 2],
    [7, 8],
    [50, 51],
    [51, 51],
    [10_000, 51],
    [0, 21],
    [-5, 21],
    [Number.NaN, 21],
  ])("limit %s reads %s rows (pageSize + 1, max 50, default 20)", async (limit, expected) => {
    const { db, calls } = fakeDb([])
    await getParentOrdersPage(db, { parentProfileId: PARENT }, { limit })
    expect(calls[0].values[4]).toBe(expected)
  })

  it("empty state: no orders, no cursor", async () => {
    const { db } = fakeDb([])
    expect(await getParentOrdersPage(db, { parentProfileId: PARENT })).toEqual({ ok: true, orders: [], nextCursor: null })
  })

  it("pageSize + 1 rows means another page; the cursor is the last row shown", async () => {
    const rows = [1, 2, 3, 4].map((i) => orderRow(i))
    const { db } = fakeDb(rows)
    const page = await getParentOrdersPage(db, { parentProfileId: PARENT }, { limit: 3 })
    expect(page.ok && page.orders.map((o) => o.id)).toEqual(rows.slice(0, 3).map((r) => r.id))
    expect(page.ok && page.nextCursor).toBe(encodeOrdersCursor({ createdAt: rows[2].created_at, id: rows[2].id }))
  })

  it("exactly pageSize rows means no next page", async () => {
    const { db } = fakeDb([1, 2, 3].map((i) => orderRow(i)))
    const page = await getParentOrdersPage(db, { parentProfileId: PARENT }, { limit: 3 })
    expect(page.ok && page.nextCursor).toBeNull()
  })

  it("a row the mapper drops still advances the cursor (never stalls)", async () => {
    const rows = [orderRow(1), orderRow(2), orderRow(3, { type: "hologram" }), orderRow(4)]
    const { db } = fakeDb(rows)
    const page = await getParentOrdersPage(db, { parentProfileId: PARENT }, { limit: 3 })
    expect(page.ok && page.orders).toHaveLength(2)
    expect(page.ok && page.nextCursor).toBe(encodeOrdersCursor({ createdAt: rows[2].created_at, id: rows[2].id }))
  })

  it("maps rows through the shared parent read model (status, completedAt, title fallback)", async () => {
    const { db } = fakeDb([
      orderRow(1, { status: "delivered", delivered_at: "2026-02-01T10:00:00.000001+00:00", title: "  " }),
      orderRow(2, { status: "rejected", candy_cost: 0 }),
    ])
    const page = await getParentOrdersPage(db, { parentProfileId: PARENT })
    expect(page.ok && page.orders).toEqual([
      expect.objectContaining({ status: "ready", completedAt: "2026-02-01T10:00:00.000001+00:00", displayTitle: "درخواست بدون عنوان" }),
      expect.objectContaining({ status: "closed", completedAt: null, candyCost: 0 }),
    ])
    // Nothing beyond the read model leaves the repository.
    expect(Object.keys((page.ok && page.orders[0]) || {}).sort()).toEqual(
      ["candyCost", "completedAt", "createdAt", "displayTitle", "id", "requestType", "status"],
    )
  })

  it("a database failure throws a normalised DbError with no raw text", async () => {
    const error = await getParentOrdersPage(failingDb("08006"), { parentProfileId: PARENT }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbError)
    expect((error as DbError).kind).toBe("unavailable")
    expect((error as Error).message).not.toContain("secret")
  })
})

describe("creation pricing", () => {
  it("returns the active catalog as key -> cost", async () => {
    const { db, calls } = fakeDb([
      { pricing_key: "image.default", candy_cost: 12 },
      { pricing_key: "video.short", candy_cost: 40 },
    ])
    expect(await getActiveCreationPrices(db)).toEqual({ ok: true, prices: { "image.default": 12, "video.short": 40 } })
    expect(calls[0].text).toMatch(/WHERE cp\.is_active/)
  })

  it.each([
    ["empty catalog", []],
    ["blank key", [{ pricing_key: " ", candy_cost: 1 }]],
    ["duplicate key", [{ pricing_key: "a", candy_cost: 1 }, { pricing_key: "a", candy_cost: 2 }]],
    ["zero cost", [{ pricing_key: "a", candy_cost: 0 }]],
    ["fractional cost", [{ pricing_key: "a", candy_cost: 1.5 }]],
    ["string cost", [{ pricing_key: "a", candy_cost: "12" }]],
    ["null key", [{ pricing_key: null, candy_cost: 3 }]],
  ])("rejects the whole catalog on %s (same rules as the route)", async (_label, rows) => {
    const { db } = fakeDb(rows)
    expect(await getActiveCreationPrices(db)).toEqual({ ok: false, reason: "invalid_catalog" })
  })
})

describe("welcome credits, wallet, users, profiles", () => {
  it.each([
    [[], 0],
    [[{ granted_count: 3, used_count: 0 }], 3],
    [[{ granted_count: 3, used_count: 2 }], 1],
    [[{ granted_count: 3, used_count: 3 }], 0],
    [[{ granted_count: 3, used_count: 5 }], 0],
    [[{ granted_count: null, used_count: 0 }], 0],
  ])("welcome credits %j -> %s", async (rows, expected) => {
    const { db } = fakeDb(rows)
    expect(await getWelcomeImageCreditsRemaining(db, { parentProfileId: PARENT })).toBe(expected)
  })

  it("only the count leaves the welcome-credit read", async () => {
    const { db, calls } = fakeDb([{ granted_count: 3, used_count: 1 }])
    expect(await getWelcomeImageCreditsRemaining(db, { parentProfileId: PARENT })).toBe(2)
    expect(calls[0].text).not.toMatch(/parent_welcome_credit_usages|\bid\b/)
  })

  it("wallet: balance, or null when there is no wallet", async () => {
    expect(await getCandyBalance(fakeDb([{ balance: 40 }]).db, { parentProfileId: PARENT })).toBe(40)
    expect(await getCandyBalance(fakeDb([]).db, { parentProfileId: PARENT })).toBeNull()
  })

  it("users and profiles: found or null", async () => {
    expect(await getUserById(fakeDb([{ id: PARENT, role: "parent", deleted: false }]).db, { userId: PARENT }))
      .toEqual({ id: PARENT, role: "parent", deleted: false })
    expect(await getUserById(fakeDb([]).db, { userId: PARENT })).toBeNull()
    expect(await findParentProfileIdByUserId(fakeDb([{ id: OTHER }]).db, { userId: PARENT })).toBe(OTHER)
    expect(await findParentProfileIdByUserId(fakeDb([]).db, { userId: PARENT })).toBeNull()
  })
})

import { describe, it, expect } from "vitest"
import { getParentOrdersPage } from "@/lib/parent/orders/queries"
import {
  ORDERS_DEFAULT_PAGE_SIZE,
  ORDERS_MAX_PAGE_SIZE,
  clampOrdersPageSize,
  encodeOrdersCursor,
  decodeOrdersCursor,
  appendUniqueById,
} from "@/lib/parent/orders/pagination"
import { createFakeSupabase, uuid, ts } from "../helpers/fake-supabase"

const ME = "profile-me"
const OTHER = "profile-other"

function order(n: number, parent = ME, extra: Record<string, unknown> = {}) {
  return { id: uuid(n), parent_id: parent, type: "image", status: "pending_review", title: `t${n}`, candy_cost: 1, created_at: ts(n), ...extra }
}
const many = (count: number, parent = ME) => Array.from({ length: count }, (_, i) => order(i + 1, parent))
const delivered = (args: Record<string, unknown>) =>
  (args.p_order_ids as string[]).map((id) => ({ order_id: id, delivered_at: "2026-03-02T00:00:00Z" }))

function setup(rows: Record<string, unknown>[]) {
  return createFakeSupabase({ tables: { orders: rows }, rpc: { get_parent_orders_delivered_at: delivered } })
}

async function walk(client: never, limit?: number) {
  const ids: string[] = []
  const pages: number[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const r = await getParentOrdersPage(client, { parentProfileId: ME }, { cursor, limit })
    if (!r.ok) throw new Error(r.reason)
    pages.push(r.orders.length)
    ids.push(...r.orders.map((o) => o.id))
    cursor = r.nextCursor
    if (!cursor) break
  }
  return { ids, pages }
}

describe("parent orders pagination", () => {
  it("first page returns the default 20, newest first, loading only pageSize + 1 rows", async () => {
    const { client, calls } = setup(many(103))
    const r = await getParentOrdersPage(client, { parentProfileId: ME })
    expect(r.ok && r.orders).toHaveLength(ORDERS_DEFAULT_PAGE_SIZE)
    expect(ORDERS_DEFAULT_PAGE_SIZE).toBe(20)
    expect(calls.limits).toEqual([21])
    if (r.ok) {
      expect(r.orders[0].id).toBe(uuid(103))
      expect(r.nextCursor).not.toBeNull()
    }
  })

  it("hard maximum is 50; absurd or invalid limits are clamped / defaulted", async () => {
    expect(ORDERS_MAX_PAGE_SIZE).toBe(50)
    expect(clampOrdersPageSize(10_000)).toBe(50)
    expect(clampOrdersPageSize("999")).toBe(50)
    expect(clampOrdersPageSize(0)).toBe(20)
    expect(clampOrdersPageSize(-3)).toBe(20)
    expect(clampOrdersPageSize("abc")).toBe(20)
    expect(clampOrdersPageSize(NaN)).toBe(20)
    const { client, calls } = setup(many(103))
    const r = await getParentOrdersPage(client, { parentProfileId: ME }, { limit: 10_000 })
    expect(r.ok && r.orders).toHaveLength(50)
    expect(calls.limits).toEqual([51])
  })

  it("second page returns the next items, deterministically, with no duplicates and none skipped", async () => {
    const { client } = setup(many(103))
    const first = await getParentOrdersPage(client, { parentProfileId: ME })
    if (!first.ok) throw new Error()
    const second = await getParentOrdersPage(client, { parentProfileId: ME }, { cursor: first.nextCursor })
    if (!second.ok) throw new Error()
    expect(second.orders[0].id).toBe(uuid(83))
    expect(second.orders).toHaveLength(20)

    const { ids, pages } = await walk(client)
    expect(pages).toEqual([20, 20, 20, 20, 20, 3])
    expect(new Set(ids).size).toBe(103)
    expect(ids).toEqual(Array.from({ length: 103 }, (_, i) => uuid(103 - i)))
  })

  it("orders by created_at DESC then id DESC: identical timestamps stay stable across pages", async () => {
    const same = Array.from({ length: 7 }, (_, i) => order(i + 1, ME, { created_at: ts(5) }))
    const { client } = setup(same)
    const { ids } = await walk(client, 3)
    expect(ids).toEqual([7, 6, 5, 4, 3, 2, 1].map(uuid))
  })

  it("a new order arriving mid-walk neither duplicates nor skips an older one", async () => {
    const rows = many(45)
    const { client } = setup(rows)
    const p1 = await getParentOrdersPage(client, { parentProfileId: ME }, { limit: 20 })
    if (!p1.ok) throw new Error()
    rows.push(order(999))
    rows.push(order(1000))
    const seen = p1.orders.map((o) => o.id)
    let cursor = p1.nextCursor
    while (cursor) {
      const r = await getParentOrdersPage(client, { parentProfileId: ME }, { cursor, limit: 20 })
      if (!r.ok) throw new Error()
      seen.push(...r.orders.map((o) => o.id))
      cursor = r.nextCursor
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toEqual(Array.from({ length: 45 }, (_, i) => uuid(45 - i)))
  })

  it("an invalid or forged cursor is rejected without touching the database", async () => {
    const { client, calls } = setup(many(5))
    for (const bad of ["garbage", "!!!", "a".repeat(500), encodeOrdersCursor({ createdAt: "x),id.gt.0", id: uuid(1) }), btoa("2026-03-01T10:00:00Z|not-a-uuid")]) {
      const r = await getParentOrdersPage(client, { parentProfileId: ME }, { cursor: bad })
      expect(r).toEqual({ ok: false, reason: "invalid_cursor" })
    }
    expect(calls.total()).toBe(0)
    expect(decodeOrdersCursor("garbage")).toBeNull()
  })

  it("never returns another parent's order, even with their id in the cursor", async () => {
    const rows = [...many(5), ...Array.from({ length: 5 }, (_, i) => order(100 + i, OTHER))]
    const { client } = setup(rows)
    const { ids } = await walk(client, 2)
    expect(ids).toEqual([5, 4, 3, 2, 1].map(uuid))
    const forged = encodeOrdersCursor({ createdAt: ts(999), id: uuid(104) })
    const r = await getParentOrdersPage(client, { parentProfileId: ME }, { cursor: forged })
    expect(r.ok && r.orders.every((o) => !o.id.startsWith("00000000-0000-4000-8000-0000000001"))).toBe(true)
  })

  it("empty history -> ok, no orders, null cursor, and the delivered_at RPC is never called", async () => {
    const { client, calls } = setup([])
    const r = await getParentOrdersPage(client, { parentProfileId: ME })
    expect(r).toEqual({ ok: true, orders: [], nextCursor: null })
    expect(calls.rpc).toHaveLength(0)
  })

  it("last page has nextCursor=null (exactly pageSize rows does not invent another page)", async () => {
    const { client } = setup(many(20))
    const r = await getParentOrdersPage(client, { parentProfileId: ME })
    expect(r.ok && r.orders).toHaveLength(20)
    expect(r.ok && r.nextCursor).toBeNull()
  })

  it("hides non-parent-visible statuses (draft / pending_payment)", async () => {
    const { client } = setup([order(1), order(2, ME, { status: "draft" }), order(3, ME, { status: "pending_payment" })])
    const { ids } = await walk(client)
    expect(ids).toEqual([uuid(1)])
  })

  it("a database error is read_failed, not a thrown error", async () => {
    const { client } = createFakeSupabase({ tables: { orders: [] }, tableErrors: { orders: { message: "boom" } } })
    expect(await getParentOrdersPage(client, { parentProfileId: ME })).toEqual({ ok: false, reason: "read_failed" })
  })
})

describe("delivered_at stays batched and page-scoped", () => {
  it("one RPC per page, carrying only that page's ids (not the whole history)", async () => {
    const { client, calls } = setup(many(103))
    const r = await getParentOrdersPage(client, { parentProfileId: ME })
    expect(calls.rpc).toHaveLength(1)
    expect(calls.rpc[0].fn).toBe("get_parent_orders_delivered_at")
    const sent = calls.rpc[0].args.p_order_ids as string[]
    expect(sent).toHaveLength(20)
    expect(sent).toEqual(r.ok ? r.orders.map((o) => o.id) : [])
    expect(sent).not.toContain(uuid(1))
  })

  it("a full walk makes exactly one RPC per page - never one per order (no N+1)", async () => {
    const { client, calls } = setup(many(103))
    const { pages } = await walk(client)
    expect(calls.rpc).toHaveLength(pages.length)
    expect(calls.rpc.length).toBeLessThan(103)
    expect(calls.rpc.every((c) => c.fn === "get_parent_orders_delivered_at")).toBe(true)
    // Every page's batch is at most the page size.
    expect(calls.rpc.every((c) => (c.args.p_order_ids as string[]).length <= 20)).toBe(true)
  })

  it("completedAt is populated from the batch result", async () => {
    const { client } = setup(many(3))
    const r = await getParentOrdersPage(client, { parentProfileId: ME })
    expect(r.ok && r.orders.every((o) => o.completedAt === "2026-03-02T00:00:00Z")).toBe(true)
  })

  it("makes no auth or profile calls of its own (context is passed in)", async () => {
    const { client, calls } = setup(many(3))
    await getParentOrdersPage(client, { parentProfileId: ME })
    expect(calls.getUser).toBe(0)
    expect(calls.from.parent_profiles).toBeUndefined()
    expect(calls.from.users).toBeUndefined()
    expect(calls.from.orders).toBe(1)
  })
})

describe("appendUniqueById", () => {
  it("ignores items already present", () => {
    expect(appendUniqueById([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map((x) => x.id)).toEqual(["a", "b", "c"])
  })
})

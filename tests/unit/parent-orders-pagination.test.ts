import { describe, it, expect } from "vitest"
import {
  ORDERS_DEFAULT_PAGE_SIZE,
  ORDERS_MAX_PAGE_SIZE,
  clampOrdersPageSize,
  encodeOrdersCursor,
  decodeOrdersCursor,
  appendUniqueById,
} from "@/lib/parent/orders/pagination"
import { parseOrdersListQuery } from "@/lib/parent/orders/list-query"
import { parseBackendOrders } from "@/lib/parent/orders/list-response"

/**
 * Pure pieces of the parent orders LIST (V0.1.45). The keyset pagination
 * itself now runs in SQL: lib/repositories/parent-orders.ts, covered by
 * repositories.test.ts (constant SQL, pageSize + 1, cursor follows the last row
 * read), postgres-repositories-db.test.ts (real SQL: ties, new rows mid-walk,
 * cross-parent cursors, max 50) and parent-orders-cutover-db.test.ts (end to end).
 * The pre-cutover Supabase query and its tests were removed with it.
 */

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const cursor = encodeOrdersCursor({ createdAt: "2026-09-01T10:00:00.000001+00:00", id: UUID(1) })

describe("page size and cursor codec", () => {
  it("default 20, hard maximum 50; invalid values default", () => {
    expect([ORDERS_DEFAULT_PAGE_SIZE, ORDERS_MAX_PAGE_SIZE]).toEqual([20, 50])
    expect(clampOrdersPageSize(1000)).toBe(50)
    expect(clampOrdersPageSize(0)).toBe(20)
    expect(clampOrdersPageSize("abc")).toBe(20)
  })

  it("round-trips microsecond timestamps and rejects forged cursors", () => {
    expect(decodeOrdersCursor(cursor)).toEqual({ createdAt: "2026-09-01T10:00:00.000001+00:00", id: UUID(1) })
    for (const bad of ["garbage", "", "e30", encodeOrdersCursor({ createdAt: "not a date", id: UUID(1) })]) {
      expect(decodeOrdersCursor(bad), bad).toBeNull()
    }
  })
})

describe("parseOrdersListQuery (shared by the Next route and the backend)", () => {
  it("accepts no parameters, a valid cursor and a limit of 1..50", () => {
    expect(parseOrdersListQuery({}, { rejectUnknown: true })).toEqual({ ok: true, query: { cursor: null, limit: null } })
    expect(parseOrdersListQuery({ cursor, limit: "50" }, { rejectUnknown: true })).toEqual({ ok: true, query: { cursor, limit: 50 } })
    expect(parseOrdersListQuery({ cursor: "", limit: "1" }, { rejectUnknown: true })).toEqual({ ok: true, query: { cursor: null, limit: 1 } })
  })

  it("rejects bad limits and cursors", () => {
    for (const limit of ["0", "51", "100000", "-1", "1.5", "abc", "", "01", " 5"]) {
      expect(parseOrdersListQuery({ limit }, { rejectUnknown: true }).ok, limit).toBe(false)
    }
    for (const c of ["garbage", "x".repeat(600), encodeOrdersCursor({ createdAt: "2026-01-01T00:00:00Z", id: "not-a-uuid" })]) {
      expect(parseOrdersListQuery({ cursor: c }, { rejectUnknown: true }).ok).toBe(false)
    }
  })

  it("a repeated parameter (array) is ambiguous and refused", () => {
    expect(parseOrdersListQuery({ cursor: [cursor, cursor] }, { rejectUnknown: true }).ok).toBe(false)
    expect(parseOrdersListQuery({ limit: ["5", "6"] }, { rejectUnknown: false }).ok).toBe(false)
  })

  it("the backend refuses identity, sorting or filtering parameters; the BFF ignores them", () => {
    for (const key of ["parentProfileId", "parent_id", "userId", "sort", "status"]) {
      expect(parseOrdersListQuery({ [key]: "x" }, { rejectUnknown: true }).ok, key).toBe(false)
      expect(parseOrdersListQuery({ [key]: "x" }, { rejectUnknown: false }).ok, key).toBe(true)
    }
  })
})

describe("parseBackendOrders (the BFF trusts nothing the backend sends)", () => {
  const good = { id: UUID(7), requestType: "image", createdAt: "2026-09-01T10:00:00.000001+00:00", displayTitle: "Order", status: "submitted", candyCost: 0, completedAt: null }

  it("keeps exactly the seven read-model fields", () => {
    const out = parseBackendOrders({ orders: [{ ...good, parent_id: "leak", title: "raw" }], nextCursor: cursor }, 200)
    expect(out).toEqual({ kind: "page", orders: [good], nextCursor: cursor })
  })

  it("maps the known error bodies", () => {
    expect(parseBackendOrders({ error: "parent_profile_not_found" }, 404)).toEqual({ kind: "rejected", status: 404, error: "parent_profile_not_found" })
    expect(parseBackendOrders({ error: "session_invalidated" }, 401)).toMatchObject({ status: 401, error: "session_invalidated" })
    expect(parseBackendOrders({ error: "forbidden" }, 403)).toMatchObject({ status: 403, error: "forbidden" })
  })

  it("throws (-> safe 503) on any malformed or unexpected body", () => {
    const bad: [unknown, number][] = [
      [null, 200],
      [{ orders: "x", nextCursor: null }, 200],
      [{ orders: [], nextCursor: "garbage" }, 200],
      [{ orders: Array.from({ length: 51 }, (_, i) => ({ ...good, id: UUID(i + 1) })), nextCursor: null }, 200],
      [{ orders: [good, good], nextCursor: null }, 200],
      [{ orders: [{ ...good, id: "not-a-uuid" }], nextCursor: null }, 200],
      [{ orders: [{ ...good, status: "pending_review" }], nextCursor: null }, 200],
      [{ orders: [{ ...good, candyCost: -1 }], nextCursor: null }, 200],
      [{ orders: [{ ...good, completedAt: "yesterday" }], nextCursor: null }, 200],
      [{ error: "forbidden" }, 401],
      [{ error: "database exploded" }, 403],
      [{ error: "invalid_request" }, 500],
    ]
    for (const [body, status] of bad) expect(() => parseBackendOrders(body, status), JSON.stringify(body).slice(0, 80)).toThrow()
  })
})

describe("appendUniqueById", () => {
  it("ignores items already present", () => {
    expect(appendUniqueById([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map((x) => x.id)).toEqual(["a", "b", "c"])
  })
})

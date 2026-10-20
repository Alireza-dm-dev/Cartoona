import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { OrdersLoadMore } from "@/components/dashboard/orders/orders-load-more"
import { OrdersEmptyState, OrdersErrorState, OrdersNoProfileState } from "@/components/dashboard/orders/orders-states"
import type { ParentOrderSummary } from "@/lib/parent/orders/types"

/**
 * Frontend contract regression for the orders LIST after the V0.1.45 cutover.
 * The components are unchanged; what changed is where their data comes from.
 * The backend's { orders, nextCursor } must render exactly as the Supabase
 * read model did: Persian labels and dates, completion date, candy cost or
 * "free", load-more vs end-of-list. (Clicking "load more" is exercised in a
 * real browser against the Docker stack; see docs/ROUTE_CUTOVER.md.)
 */

const order = (n: number, extra: Partial<ParentOrderSummary> = {}): ParentOrderSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  requestType: "image",
  createdAt: "2026-09-01T11:00:00.000001+00:00",
  displayTitle: `سفارش ${n}`,
  status: "submitted",
  candyCost: 12,
  completedAt: null,
  ...extra,
})

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe("orders list rendering from the backend read model", () => {
  it("first page with more to come: cards in order, Persian dates/costs, and the load-more button", () => {
    const out = html(createElement(OrdersLoadMore, {
      initialOrders: [order(5, { requestType: "video", candyCost: 40, status: "creating" }), order(1, { candyCost: 0, status: "ready", completedAt: "2026-09-02T10:00:00.345678+00:00" })],
      initialCursor: "opaque-cursor",
    }))
    expect(out.indexOf("سفارش 5")).toBeLessThan(out.indexOf("سفارش 1"))
    expect(out).toContain("ثبت شده در:")
    expect(out).toContain("۴۰ آبنبات")
    expect(out).toContain("رایگان")
    expect(out).toContain("تحویل شده در:")
    expect(out).toMatch(/۱۴۰۵|۲۰۲۶|شهریور|سپتامبر/)
    expect(out).toContain('data-testid="orders-load-more"')
    expect(out).toContain("نمایش سفارش‌های بیشتر")
    expect(out).not.toContain('data-testid="orders-end"')
    expect(out).toContain(`/dashboard/orders/${order(5).id}`)
  })

  it("last page: no button, the end-of-list message", () => {
    const out = html(createElement(OrdersLoadMore, { initialOrders: [order(1)], initialCursor: null }))
    expect(out).not.toContain('data-testid="orders-load-more"')
    expect(out).toContain("همه سفارش‌های شما نمایش داده شد.")
  })

  it("an order never delivered shows no completion date", () => {
    const out = html(createElement(OrdersLoadMore, { initialOrders: [order(1)], initialCursor: null }))
    expect(out).not.toContain("تحویل شده در:")
  })

  it("empty, no-profile and error states keep their Persian copy", () => {
    for (const [el, persian] of [[OrdersEmptyState, /[؀-ۿ]/], [OrdersNoProfileState, /[؀-ۿ]/], [OrdersErrorState, /[؀-ۿ]/]] as const) {
      const out = html(createElement(el))
      expect(out).toMatch(persian)
      expect(out).not.toMatch(/undefined|null|backend|error:/i)
    }
  })
})

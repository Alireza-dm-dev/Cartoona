import { toPaymentSource, type PaymentSource } from "@/lib/credits/welcome-image-credits"

/**
 * What a successful request submission is allowed to tell the browser.
 *
 * The RPC returns more than the client needs, and the route has more still in
 * scope — the storage path, the bucket name, the parent profile id, the raw
 * Postgres error. None of that is useful to the page, and a storage path in
 * particular is the one value the whole private-media design works to keep out
 * of the browser. So the response is built by this allow-list rather than by
 * spreading the row: a column added to `orders` later cannot widen it by
 * accident.
 *
 * The order id is the single field the page actually acts on — it redirects to
 * /dashboard/orders/<id> — and is deliberately the canonical one returned by
 * the database rather than the one the route generated, so the client can
 * never end up pointing at an order that was not created.
 */

export interface SubmissionSuccess {
  success: true
  orderId: string
  /** Echoed for display only; the detail page re-reads everything it needs. */
  type: string | null
  status: string | null
  candyCost: number | null
  /**
   * Whether this response is a replay of an earlier attempt for the same
   * submission key rather than a just-created order. Internal/diagnostic
   * only — the client redirects to the same place either way and does not
   * need to branch on it.
   */
  replayed: boolean
  /**
   * What paid for the order: a welcome image credit or candy. On a replay this
   * is the ORIGINAL order's source. Always present; an RPC/row that predates
   * the column is reported as "candy", which is what it was.
   */
  paymentSource: PaymentSource
}

/** Unknown shape of the single row `create_parent_request_trusted` returns. */
export interface RawCreatedOrderRow {
  id?: unknown
  type?: unknown
  status?: unknown
  candy_cost?: unknown
  replayed?: unknown
  payment_source?: unknown
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Narrow the created-order row to the safe response.
 *
 * Returns null when the row carries no usable id. That is treated as a failure
 * by the caller rather than answered with a half-built success, because a
 * client that redirects to /dashboard/orders/undefined is worse than an honest
 * error.
 */
export function toSubmissionSuccess(row: unknown): SubmissionSuccess | null {
  if (!row || typeof row !== "object") return null

  const candidate = row as RawCreatedOrderRow
  const orderId = text(candidate.id)
  if (!orderId) return null

  return {
    success: true,
    orderId,
    type: text(candidate.type),
    status: text(candidate.status),
    candyCost:
      typeof candidate.candy_cost === "number" && Number.isFinite(candidate.candy_cost)
        ? candidate.candy_cost
        : null,
    replayed: candidate.replayed === true,
    paymentSource: toPaymentSource(candidate.payment_source),
  }
}

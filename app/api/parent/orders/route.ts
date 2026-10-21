import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { loadParentOrdersPage, type ParentOrdersListFailure } from "@/lib/parent/orders/backend-orders"
import { parseOrdersListQuery } from "@/lib/parent/orders/list-query"
import { log, withObservability } from "@/lib/observability/request-context"

/**
 * GET /api/parent/orders?cursor=&limit= - one page of the signed-in parent's
 * own orders, for "load more" (V0.1.45: served by the backend).
 *
 *   browser -> this route (BFF) -> Supabase Auth verification -> signed v2
 *   assertion -> Fastify GET /v1/parent/orders -> PostgreSQL
 *
 * This route reads no business data itself: no Supabase table or RPC, no pg,
 * no repository. It verifies the session, asks the backend, and maps the
 * answer. The browser never sees the backend address or the assertion, and
 * nothing it sends (headers, other query parameters) can name the caller.
 *
 *   200 { orders, nextCursor }        nextCursor opaque, null on the last page;
 *                                     a parent with no profile yet gets an empty page
 *   400 code invalid_request          bad cursor/limit (checked before any auth work)
 *   401 code unauthenticated          no or rejected session
 *   401 code session_expired          30-day lifetime over (local sign-out)
 *   401 code session_invalidated      before users.sessions_not_before (local sign-out)
 *   403 code identity_not_linked      verified, no Cartoona user mapped
 *   403 code forbidden                not a parent (admin, super_admin) or deleted
 *   503 code auth_unavailable         identity provider down/slow (no sign-out)
 *   503 code service_unavailable      backend or database down/slow/malformed (no sign-out)
 *
 * Every body carries a Persian `error` message for display and a stable `code`.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const

const LOGIN = "لطفاً ابتدا وارد حساب خود شوید"
const SIGN_IN_AGAIN = "برای ادامه دوباره وارد حساب شوید."
const NOT_ALLOWED = "شما مجوز انجام این عملیات را ندارید."
const INVALID = "درخواست نامعتبر است."
const UNAVAILABLE = "فهرست سفارش‌ها در دسترس نیست. لطفاً دوباره تلاش کنید."
const SESSION_CHECK_UNAVAILABLE = "بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید."

const FAILURES: Record<Exclude<ParentOrdersListFailure, "no_parent_profile">, { status: number; error: string }> = {
  invalid_request: { status: 400, error: INVALID },
  unauthenticated: { status: 401, error: LOGIN },
  session_expired: { status: 401, error: SIGN_IN_AGAIN },
  session_invalidated: { status: 401, error: SIGN_IN_AGAIN },
  identity_not_linked: { status: 403, error: NOT_ALLOWED },
  forbidden: { status: 403, error: NOT_ALLOWED },
  auth_unavailable: { status: 503, error: SESSION_CHECK_UNAVAILABLE },
  service_unavailable: { status: 503, error: UNAVAILABLE },
}

async function handleGet(request: Request) {
  const search = new URL(request.url).searchParams
  // Only cursor/limit are read; a repeated one is passed as an array and refused.
  const pick = (name: string) => {
    const all = search.getAll(name)
    return all.length === 0 ? undefined : all.length === 1 ? all[0] : all
  }
  // A forged cursor or bad limit is rejected before any auth or backend work.
  const parsed = parseOrdersListQuery({ cursor: pick("cursor"), limit: pick("limit") }, { rejectUnknown: false })
  if (!parsed.ok) {
    log("info", "ORDERS_PAGE_REJECTED", { reason: "invalid_request" })
    return NextResponse.json({ error: INVALID, code: "invalid_request" }, { status: 400, headers: NO_STORE })
  }

  const result = await loadParentOrdersPage(parsed.query)
  if (result.ok) return NextResponse.json({ orders: result.orders, nextCursor: result.nextCursor }, { headers: NO_STORE })

  if (result.reason === "no_parent_profile") {
    // Unchanged contract: a parent who has not finished signup has no orders yet.
    return NextResponse.json({ orders: [], nextCursor: null }, { headers: NO_STORE })
  }
  if (result.reason === "session_expired" || result.reason === "session_invalidated") await endParentSession()

  const failure = FAILURES[result.reason]
  const headers = failure.status === 503 ? { ...NO_STORE, "Retry-After": "2" } : NO_STORE
  return NextResponse.json({ error: failure.error, code: result.reason }, { status: failure.status, headers })
}

export const GET = withObservability("GET /api/parent/orders", handleGet)

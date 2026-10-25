import { NextResponse } from "next/server"
import { withObservability } from "@/lib/observability/request-context"
import { callFailureResponse, flatError, NO_STORE, verifiedCaller } from "@/lib/http/backend-route-responses"
import { loadAdminReferrals } from "@/lib/referrals/backend-referrals"

export const dynamic = "force-dynamic"

function clampPageSize(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 25
  return Math.min(Math.max(Math.round(n), 1), 50)
}

function clampPage(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.max(Math.round(n), 1)
}

/**
 * GET /api/admin/referrals (V0.1.53: PostgreSQL through the backend). The admin
 * role is enforced by the backend (403 for a parent) and again inside the
 * trusted functions; nothing is read from Supabase.
 */
export const GET = withObservability("GET /api/admin/referrals", handleGet)

async function handleGet(request: Request) {
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response

  const url = new URL(request.url)
  const search = url.searchParams.get("search") || undefined
  if (search && search.length > 100) return flatError("جستجو حداکثر ۱۰۰ کاراکتر می‌تواند باشد.", 400)

  const result = await loadAdminReferrals(caller.context, {
    search,
    page: clampPage(url.searchParams.get("page")),
    pageSize: clampPageSize(url.searchParams.get("pageSize")),
  })
  if (result.ok) return NextResponse.json(result.response, { headers: NO_STORE })
  if (result.kind === "refused") return flatError("خطا در دریافت لیست روابط.", 500)
  return callFailureResponse(result, "خطا در دریافت لیست روابط.")
}

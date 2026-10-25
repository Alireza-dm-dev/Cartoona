import { NextResponse } from "next/server"
import { withObservability } from "@/lib/observability/request-context"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { getParentGalleryMedia } from "@/lib/parent/gallery/queries"

/**
 * GET /api/parent/gallery - the signed-in parent's own source media (V0.1.52).
 *
 * Backs the "انتخاب از گالری خصوصی" picker on /complete-request, which is a
 * client component and so cannot read the database directly.
 *
 *   Supabase Auth verification (identity only) -> backend GET /v1/parent/gallery
 *   (PostgreSQL ownership + keyset page) -> Storage signs only this page's keys.
 *
 * The body is the read model the gallery page renders: ids, short-lived signed
 * previews and display labels. No storage paths, and no way to ask for another
 * parent's media - ownership comes from the verified session, never the query.
 * If Storage is down, items still list with a null preview and the request
 * does not sign anyone out.
 */
export const dynamic = "force-dynamic"

export const GET = withObservability("GET /api/parent/gallery", handleGet)

async function handleGet(request: Request) {
  const caller = await verifyParentCaller()
  if (!caller.ok) {
    if (caller.reason === "auth_unavailable") {
      return NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, { status: 503, headers: { "Retry-After": "2" } })
    }
    if (caller.reason === "session_expired") {
      await endParentSession()
      return NextResponse.json({ error: "برای ادامه دوباره وارد حساب شوید.", code: "PARENT_SESSION_EXPIRED" }, { status: 401 })
    }
    return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
  }

  // Bounded paging: `limit` is clamped server-side, `cursor` is opaque and
  // validated, and nothing here ever asks for the whole library.
  const params = new URL(request.url).searchParams
  const result = await getParentGalleryMedia(caller.context, {
    cursor: params.get("cursor"),
    limit: params.has("limit") ? Number.parseInt(params.get("limit") ?? "", 10) : undefined,
  })

  if (!result.ok) {
    if (result.reason === "unauthenticated") {
      return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
    }
    if (result.reason === "forbidden") {
      return NextResponse.json({ error: "شما مجوز انجام این عملیات را ندارید." }, { status: 403 })
    }
    if (result.reason === "invalid_cursor") {
      return NextResponse.json({ error: "درخواست نامعتبر است." }, { status: 400 })
    }
    if (result.reason === "no_parent_profile") {
      // Not an error for the picker: an account without a parent profile
      // simply has no media to offer.
      return NextResponse.json({ media: [], nextCursor: null })
    }
    return NextResponse.json({
      error: "گالری خصوصی در دسترس نیست. لطفاً دوباره تلاش کنید.",
    }, { status: 500 })
  }

  return NextResponse.json({ media: result.media, nextCursor: result.nextCursor })
}

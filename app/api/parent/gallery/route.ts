import { NextResponse } from "next/server"
import { withObservability } from "@/lib/observability/request-context"
import { logAuthLookup } from "@/lib/observability/auth-events"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createParentSessionFailureResponse } from "@/lib/auth/expired-parent-session-response"
import { getParentGalleryMedia } from "@/lib/parent/gallery/queries"

/**
 * GET /api/parent/gallery — the signed-in parent's own source media.
 *
 * Backs the "انتخاب از گالری خصوصی" picker on /complete-request, which is a
 * client component and so cannot read the database directly.
 *
 * The response body is the same read model the gallery page renders: ids,
 * short-lived signed previews and display labels. No storage paths, and no
 * way to ask for another parent's media — the query resolves ownership from
 * the session rather than from anything the caller sends.
 */
export const dynamic = "force-dynamic"

export const GET = withObservability("GET /api/parent/gallery", handleGet)

async function handleGet(request: Request) {
  const supabase = await createServerSupabaseClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    logAuthLookup(authError)
    return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
  }

  const lifetime = await checkParentSessionLifetime(supabase, user.id)
  if (!lifetime.valid) {
    return createParentSessionFailureResponse(supabase, lifetime)
  }

  // Bounded paging: `limit` is clamped server-side, `cursor` is opaque and
  // validated, and nothing here ever asks for the whole library.
  const params = new URL(request.url).searchParams
  const result = await getParentGalleryMedia(supabase, {
    cursor: params.get("cursor"),
    limit: params.has("limit") ? Number.parseInt(params.get("limit") ?? "", 10) : undefined,
  })

  if (!result.ok) {
    if (result.reason === "unauthenticated") {
      return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
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

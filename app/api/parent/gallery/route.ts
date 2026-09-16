import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"
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

export async function GET() {
  const supabase = await createServerSupabaseClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  const result = await getParentGalleryMedia(supabase)

  if (!result.ok) {
    if (result.reason === "unauthenticated") {
      return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
    }
    if (result.reason === "no_parent_profile") {
      // Not an error for the picker: an account without a parent profile
      // simply has no media to offer.
      return NextResponse.json({ media: [] })
    }
    return NextResponse.json({
      error: "گالری خصوصی در دسترس نیست. لطفاً دوباره تلاش کنید.",
    }, { status: 500 })
  }

  return NextResponse.json({ media: result.media })
}

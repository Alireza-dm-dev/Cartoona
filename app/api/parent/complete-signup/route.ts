import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { ensureParentProfile } from "@/lib/parent/ensure-parent-profile"

/**
 * Finishes a production parent signup once the SMS code has been verified.
 *
 * The browser completes verification and holds the session; the profile row is
 * created here, server-side, against that session. Until this ran, a production
 * signup produced an auth user with no `parent_profiles` row, so the parent
 * reached the dashboard with nothing to read — the dev route created a profile
 * but the production path never did.
 *
 * Safe to call more than once: `ensureParentProfile` is idempotent, so a retry
 * after a network failure returns the existing profile.
 *
 * Signup is phone + OTP only and collects no name, so there is usually nothing
 * to write into `full_name`. A name is still honoured if one happens to be on
 * the identity — an older account, or a future flow that sets it — but its
 * absence is not an error and no placeholder is substituted.
 */
export async function POST() {
  const supabase = await createServerSupabaseClient()

  // The session cookie is the only input; nothing about the parent is taken
  // from the request body, so a caller cannot name someone else's account.
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow) {
    return NextResponse.json(
      { error: "تکمیل ثبت‌نام انجام نشد. لطفاً دوباره تلاش کنید." },
      { status: 500 },
    )
  }

  // Admin and super_admin identities are never given a parent profile here.
  if (userRow.role !== "parent") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const metadataName = user.user_metadata?.full_name
  const trimmedName = typeof metadataName === "string" ? metadataName.trim() : ""
  const fullName = trimmedName.length > 0 ? trimmedName : null

  // Signup never implies consent: the profile starts un-consented (column
  // defaults) and the parent grants consent on /parent-consent (PostgreSQL).
  const result = await ensureParentProfile(supabase, {
    userId: user.id,
    fullName,
  })

  if (!result.ok) {
    // The underlying database reason is deliberately not echoed to the client.
    return NextResponse.json(
      { error: "تکمیل ثبت‌نام انجام نشد. لطفاً دوباره تلاش کنید." },
      { status: 500 },
    )
  }

  return NextResponse.json(
    { success: true, created: result.created, next: "/parent-consent" },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

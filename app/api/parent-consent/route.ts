import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"

const SUPPORTED_FIELDS = new Set(["consentGranted"])

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || userRow.role !== "parent") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 })
  }

  const extraKeys = Object.keys(body).filter((k) => !SUPPORTED_FIELDS.has(k))
  if (extraKeys.length > 0) {
    return NextResponse.json({ error: "Unsupported fields" }, { status: 422 })
  }

  if (body.consentGranted !== true) {
    return NextResponse.json({ error: "Invalid consent value" }, { status: 422 })
  }

  const fullName = user.user_metadata?.full_name
  if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
    return NextResponse.json({ error: "Failed to record consent" }, { status: 500 })
  }

  const consentGrantedAt = new Date().toISOString()

  const { data: existing } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (existing) {
    const { error: updateError } = await supabase
      .from("parent_profiles")
      .update({
        consent_granted: true,
        consent_granted_at: consentGrantedAt,
      })
      .eq("user_id", user.id)
      .select()
      .maybeSingle()

    if (updateError) {
      return NextResponse.json({ error: "Failed to record consent" }, { status: 500 })
    }
  } else {
    const { error: insertError } = await supabase
      .from("parent_profiles")
      .insert({
        user_id: user.id,
        full_name: fullName.trim(),
        consent_granted: true,
        consent_granted_at: consentGrantedAt,
      })
      .select()
      .maybeSingle()

    if (insertError) {
      return NextResponse.json({ error: "Failed to record consent" }, { status: 500 })
    }
  }

  return NextResponse.json({
    success: true,
    consentGranted: true,
    consentGrantedAt,
  })
}

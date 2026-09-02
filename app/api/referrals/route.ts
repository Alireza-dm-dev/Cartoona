import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"

function jsonError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

export const dynamic = "force-dynamic"

export async function GET() {
  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return jsonError("خطای احراز هویت رخ داد.", 500)
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401)
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || userRow.role !== "parent") {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  const { data: rpcData, error: rpcError } = await supabase
    .rpc("get_current_parent_referral_summary")

  if (rpcError || !rpcData || !Array.isArray(rpcData) || rpcData.length !== 1) {
    return jsonError("برنامه معرفی در حال حاضر در دسترس نیست.", 500)
  }

  const row = rpcData[0] as Record<string, unknown>

  if (!row || typeof row.referral_code !== "string") {
    return jsonError("برنامه معرفی در حال حاضر در دسترس نیست.", 500)
  }

  return NextResponse.json(
    {
      referralCode: row.referral_code,
      program: {
        isEnabled: Boolean(row.is_enabled),
        rewardBasisPoints: Number(row.reward_basis_points),
      },
      binding: {
        isBound: Boolean(row.is_bound),
        boundAt: typeof row.bound_at === "string" ? row.bound_at : null,
      },
      referredCount: Number(row.referred_count),
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

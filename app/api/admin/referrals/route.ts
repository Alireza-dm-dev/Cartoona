import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isAdminRole } from "@/lib/auth/admin-role"
import type {
  AdminReferralListResponse,
  AdminReferralRelationship,
} from "@/lib/referrals/admin-types"

export const dynamic = "force-dynamic"

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

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

export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return jsonError("لطفاً ابتدا وارد حساب خود شوید.", 401)
    }

    const { data: roleRow, error: roleError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle()

    if (roleError || !roleRow || !isAdminRole(roleRow.role)) {
      return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
    }

    const url = new URL(request.url)
    const search = url.searchParams.get("search") || undefined
    const page = clampPage(url.searchParams.get("page"))
    const pageSize = clampPageSize(url.searchParams.get("pageSize"))

    if (search && search.length > 100) {
      return jsonError("جستجو حداکثر ۱۰۰ کاراکتر می‌تواند باشد.", 400)
    }

    const offset = (page - 1) * pageSize

    const [overviewResult, relationshipsResult] = await Promise.all([
      supabase.rpc("get_admin_referral_overview"),
      supabase.rpc("get_admin_referral_relationships", {
        p_search: search || null,
        p_limit: pageSize,
        p_offset: offset,
      }),
    ])

    if (overviewResult.error) {
      return jsonError("خطا در دریافت خلاصه اطلاعات.", 500)
    }

    if (relationshipsResult.error) {
      return jsonError("خطا در دریافت لیست روابط.", 500)
    }

    const overviewRow = Array.isArray(overviewResult.data)
      ? (overviewResult.data[0] as Record<string, unknown>)
      : null

    const settings = {
      isEnabled: Boolean(overviewRow?.is_enabled ?? false),
      rewardBasisPoints: Number(overviewRow?.reward_basis_points ?? 0),
      updatedAt: typeof overviewRow?.settings_updated_at === "string"
        ? overviewRow.settings_updated_at
        : new Date(0).toISOString(),
    }

    const metrics = {
      totalParentProfiles: Number(overviewRow?.total_parent_profiles ?? 0),
      totalRelationships: Number(overviewRow?.total_referral_relationships ?? 0),
      totalUnboundParentProfiles: Number(overviewRow?.total_unbound_parent_profiles ?? 0),
      totalDeletedIdentityRelationships: Number(overviewRow?.total_deleted_identity_relationships ?? 0),
      settingsHistoryCount: Number(overviewRow?.settings_history_count ?? 0),
    }

    const rawRows = Array.isArray(relationshipsResult.data) ? relationshipsResult.data : []
    let total = 0
    const relationships: AdminReferralRelationship[] = rawRows.map((row: Record<string, unknown>, idx: number) => {
      if (idx === 0) total = Number(row.total_count ?? 0)
      return {
        id: String(row.relationship_id ?? ""),
        boundAt: String(row.bound_at ?? ""),
        bindingSource: String(row.binding_source ?? "manual"),
        referralCodeSnapshot: String(row.referral_code_snapshot ?? ""),
        referredParent: row.referred_parent_id !== null
          ? {
              name: row.referred_parent_name !== null ? String(row.referred_parent_name) : null,
              email: row.referred_parent_email !== null ? String(row.referred_parent_email) : null,
            }
          : null,
        referrerParent: row.referrer_parent_id !== null
          ? {
              name: row.referrer_parent_name !== null ? String(row.referrer_parent_name) : null,
              email: row.referrer_parent_email !== null ? String(row.referrer_parent_email) : null,
              currentCode: row.referrer_current_code !== null ? String(row.referrer_current_code) : null,
            }
          : null,
      }
    })
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0

    const response: AdminReferralListResponse = {
      settings,
      metrics,
      relationships,
      pagination: { page, pageSize, total, totalPages },
    }

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return jsonError("خطای داخلی سرور.", 500)
  }
}

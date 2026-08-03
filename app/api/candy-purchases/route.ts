import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { isParentRole } from "@/lib/auth/parent-access"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"
import {
  toParentCandyPurchaseSummary,
  type CouponAppliedStatus,
  type PurchaseReadModelRow,
} from "@/lib/candy-purchases/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 1024

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

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

  if (roleError || !userRow || !isParentRole(userRow.role)) {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  const { data: parentProfile } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!parentProfile) {
    return jsonError("پروفایل والد یافت نشد.", 400)
  }

  const { data: wallet } = await supabase
    .from("candy_wallets")
    .select("balance")
    .eq("parent_id", parentProfile.id)
    .maybeSingle()

  const { data: purchases, error: purchasesError } = await supabase
    .from("candy_purchases")
    .select("id, package_id, candy_amount, price_amount, original_price_amount, discount_amount, final_price_amount, currency, status, created_at, paid_at")
    .eq("parent_id", parentProfile.id)
    .order("created_at", { ascending: false })

  if (purchasesError) {
    return jsonError("دریافت اطلاعات خرید انجام نشد.", 500)
  }

  const purchaseIds = (purchases || []).map((p) => p.id)

  // paymentStarted — derived from whether ANY payment attempt exists for the
  // purchase. Only a boolean is returned; attempt ID / provider / session /
  // transaction IDs are never exposed.
  const attemptsByPurchase = new Set<string>()
  if (purchaseIds.length > 0) {
    const { data: attempts } = await supabase
      .from("payment_attempts")
      .select("purchase_id")
      .in("purchase_id", purchaseIds)
    if (attempts) {
      for (const a of attempts) attemptsByPurchase.add(a.purchase_id)
    }
  }

  // Coupon snapshot — authoritative source is the coupon_redemptions row
  // (code, redemption status, and applied pricing snapshots), so the history
  // keeps working even if the coupon is later edited or deactivated. Internal
  // coupon_id / redemption_id are resolved server-side and never returned.
  const redemptionByPurchase = new Map<string, { couponId: string; code: string; status: CouponAppliedStatus }>()
  if (purchaseIds.length > 0) {
    const { data: redemptions } = await supabase
      .from("coupon_redemptions")
      .select("purchase_id, coupon_id, normalized_code_snapshot, status")
      .in("purchase_id", purchaseIds)
    if (redemptions) {
      for (const r of redemptions) {
        const status = r.status as CouponAppliedStatus
        if (status === "reserved" || status === "redeemed" || status === "cancelled") {
          redemptionByPurchase.set(r.purchase_id, {
            couponId: r.coupon_id,
            code: r.normalized_code_snapshot,
            status,
          })
        }
      }
    }
  }

  // Safe coupon display name — only the name is joined (via a limited admin
  // lookup), never internal configuration such as discount rules or limits.
  const couponNameByCouponId = new Map<string, string>()
  const couponIds = [...new Set([...redemptionByPurchase.values()].map((r) => r.couponId))]
  if (couponIds.length > 0) {
    let admin
    try {
      admin = createAdminSupabaseClient()
    } catch {
      admin = null
    }
    if (admin) {
      const { data: coupons } = await admin
        .from("coupons")
        .select("id, name")
        .in("id", couponIds)
      if (coupons) {
        for (const c of coupons) {
          if (typeof c.name === "string" && c.name.trim().length > 0) {
            couponNameByCouponId.set(c.id, c.name)
          }
        }
      }
    }
  }

  const packageIds = [...new Set((purchases || []).map((p) => p.package_id))]
  const packageNames: Record<string, string> = {}

  if (packageIds.length > 0) {
    const { data: pkgs } = await supabase
      .from("candy_packages")
      .select("id, name")
      .in("id", packageIds)
    if (pkgs) {
      for (const p of pkgs) {
        packageNames[p.id] = p.name
      }
    }
  }

  const result = {
    wallet: { balance: wallet?.balance ?? 0 },
    purchases: (purchases || []).map((p) => {
      const redemption = redemptionByPurchase.get(p.id)
      const row: PurchaseReadModelRow = {
        id: p.id,
        candy_amount: p.candy_amount,
        price_amount: p.price_amount,
        original_price_amount: p.original_price_amount,
        discount_amount: p.discount_amount,
        final_price_amount: p.final_price_amount,
        currency: p.currency,
        status: p.status,
        created_at: p.created_at,
        paid_at: p.paid_at,
        coupon_code_snapshot: redemption ? redemption.code : null,
        coupon_status: redemption ? redemption.status : null,
        coupon_name: redemption ? couponNameByCouponId.get(redemption.couponId) ?? null : null,
        payment_started: attemptsByPurchase.has(p.id),
      }
      return toParentCandyPurchaseSummary(row, packageNames[p.package_id] || "")
    }),
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("application/json")) {
    return jsonError("فرمت درخواست باید JSON باشد.", 415)
  }

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10)
    if (isNaN(len) || len < 0) {
      return jsonError("درخواست نامعتبر است.", 400)
    }
    if (len > MAX_BODY_BYTES) {
      return jsonError("حجم درخواست بیش از حد مجاز است.", 413)
    }
  }

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

  if (roleError || !userRow || !isParentRole(userRow.role)) {
    return jsonError("شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  // Parse and validate body
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      return jsonError("حجم درخواست بیش از حد مجاز است.", 413)
    }
    body = JSON.parse(text)
  } catch {
    return jsonError("فرمت JSON نامعتبر است.", 400)
  }

  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== "package_id") {
    return jsonError("فیلدهای ناشناخته در درخواست وجود دارد.", 400)
  }

  const packageId: unknown = body.package_id
  if (typeof packageId !== "string" || packageId.trim().length === 0) {
    return jsonError("شناسه بسته نامعتبر است.", 400)
  }

  // Resolve parent profile
  const { data: parentProfile } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!parentProfile) {
    return jsonError("پروفایل والد یافت نشد.", 400)
  }

  // Load active package
  const { data: pkg, error: pkgError } = await supabase
    .from("candy_packages")
    .select("id, candy_amount, price_amount, currency")
    .eq("id", packageId)
    .eq("is_active", true)
    .maybeSingle()

  if (pkgError || !pkg) {
    return jsonError("بسته مورد نظر یافت نشد یا فعال نیست.", 404)
  }

  // Create pending purchase. Snapshots original and final price (no coupon yet).
  const { data: purchase, error: insertError } = await supabase
    .from("candy_purchases")
    .insert({
      parent_id: parentProfile.id,
      package_id: pkg.id,
      candy_amount: pkg.candy_amount,
      price_amount: pkg.price_amount,
      original_price_amount: pkg.price_amount,
      discount_amount: 0,
      final_price_amount: pkg.price_amount,
      currency: pkg.currency,
      status: "pending",
    })
    .select("id, candy_amount, price_amount, discount_amount, final_price_amount, currency, status, created_at")
    .single()

  if (insertError || !purchase) {
    return jsonError("ایجاد خرید با خطا مواجه شد.", 500)
  }

  return NextResponse.json(
    { purchase },
    {
      status: 201,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  )
}

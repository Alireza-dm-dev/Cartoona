import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { isParentRole } from "@/lib/auth/parent-access"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_BODY_BYTES = 1024

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  )
}

const SIM_DISABLED_CODE = "PAYMENT_SIMULATION_DISABLED"

function isSimulationEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false
  return process.env.CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION === "true"
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("application/json")) {
    return jsonError("INVALID_FORMAT", "فرمت درخواست باید JSON باشد.", 415)
  }

  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10)
    if (isNaN(len) || len < 0) {
      return jsonError("INVALID_REQUEST", "درخواست نامعتبر است.", 400)
    }
    if (len > MAX_BODY_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", "حجم درخواست بیش از حد مجاز است.", 413)
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // [DEVELOPMENT-ONLY] Simulated payment completion
  // Production is always disabled. Non-production requires explicit env var.
  // ═════════════════════════════════════════════════════════════════════════

  if (!isSimulationEnabled()) {
    return jsonError(SIM_DISABLED_CODE, "تکمیل آزمایشی پرداخت در این محیط فعال نیست.", 403)
  }

  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return jsonError("AUTH_ERROR", "خطای احراز هویت رخ داد.", 500)
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return jsonError("UNAUTHENTICATED", "لطفاً ابتدا وارد حساب خود شوید.", 401)
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || !isParentRole(userRow.role)) {
    return jsonError("FORBIDDEN", "شما مجوز انجام این عملیات را ندارید.", 403)
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  // Parse optional body (payment_reference)
  let paymentReference: string | null = null
  try {
    const text = await request.text()
    if (text.length > 0) {
      if (text.length > MAX_BODY_BYTES) {
        return jsonError("REQUEST_TOO_LARGE", "حجم درخواست بیش از حد مجاز است.", 413)
      }
      const body = JSON.parse(text)
      const keys = Object.keys(body)
      if (keys.length > 1 || (keys.length === 1 && keys[0] !== "payment_reference")) {
        return jsonError("UNKNOWN_FIELDS", "فیلدهای ناشناخته در درخواست وجود دارد.", 400)
      }
      if (body.payment_reference !== undefined) {
        if (typeof body.payment_reference !== "string") {
          return jsonError("INVALID_PAYMENT_REFERENCE", "فرمت payment_reference نامعتبر است.", 400)
        }
        paymentReference = body.payment_reference
      }
    }
  } catch {
    return jsonError("INVALID_JSON", "فرمت JSON نامعتبر است.", 400)
  }

  const { id: purchaseId } = await params

  if (!purchaseId || purchaseId.trim().length === 0) {
    return jsonError("INVALID_PURCHASE_ID", "شناسه خرید نامعتبر است.", 400)
  }

  // Resolve parent profile ID for the trusted RPC
  const { data: parentProfile } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!parentProfile) {
    return jsonError("PARENT_PROFILE_NOT_FOUND", "پروفایل والد یافت نشد.", 400)
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Call the trusted server-only RPC through the admin client (service_role).
  // The server authenticated the parent and resolved the verified
  // parent_profile_id. The RPC receives this verified ID and performs
  // ownership check inside the database transaction.
  // ═════════════════════════════════════════════════════════════════════════

  let admin
  try {
    admin = createAdminSupabaseClient()
  } catch {
    return jsonError("SERVER_CONFIG_ERROR", "خطای پیکربندی سرور.", 500)
  }

  const { data: rpcData, error: rpcError } = await admin
    .rpc("complete_candy_purchase_trusted", {
      p_purchase_id: purchaseId,
      p_parent_profile_id: parentProfile.id,
      p_payment_reference: paymentReference ?? "dev-simulated-" + String(Date.now()),
    })

  if (rpcError) {
    const message = rpcError.message
    if (message.includes("purchase_not_found")) {
      return jsonError("PURCHASE_NOT_FOUND", "خرید مورد نظر یافت نشد.", 404)
    }
    if (message.includes("purchase_not_owner")) {
      return jsonError("PURCHASE_NOT_OWNER", "این خرید متعلق به شما نیست.", 403)
    }
    if (message.includes("purchase_not_pending")) {
      return jsonError("PURCHASE_NOT_PENDING", "این خرید در وضعیت قابل تکمیل نیست.", 409)
    }
    if (message.includes("purchase_wallet_not_found")) {
      return jsonError("WALLET_NOT_FOUND", "کیف آبنبات یافت نشد.", 500)
    }
    return jsonError("COMPLETION_FAILED", "خطا در تکمیل خرید.", 500)
  }

  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as Record<string, unknown> | null
  if (!row) {
    return jsonError("COMPLETION_FAILED", "خطا در تکمیل خرید.", 500)
  }

  return NextResponse.json(
    {
      purchase_id: row.purchase_id,
      purchase_status: row.purchase_status,
      wallet_id: row.wallet_id,
      wallet_balance: row.wallet_balance,
      ledger_entry_id: row.ledger_entry_id,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Dev-Endpoint": "This is a development-only simulated payment endpoint. Do not use in production.",
      },
    },
  )
}

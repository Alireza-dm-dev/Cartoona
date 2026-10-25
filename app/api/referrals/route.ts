import { NextResponse } from "next/server"
import { withObservability } from "@/lib/observability/request-context"
import { callFailureResponse, flatError, NO_STORE, verifiedCaller } from "@/lib/http/backend-route-responses"
import { loadParentReferralSummary } from "@/lib/referrals/backend-referrals"

/**
 * GET /api/referrals - the signed-in parent's referral summary (V0.1.53:
 * PostgreSQL through the backend; no Supabase table or RPC).
 *
 *   Supabase Auth verification (identity only) -> v2 assertion -> Fastify
 *   GET /v1/parent/referrals -> get_parent_referral_summary_trusted
 *
 * The role (parent only), the 30-day / sessions_not_before session policy and
 * the profile all come from PostgreSQL; the browser names nothing.
 */
export const dynamic = "force-dynamic"

export const GET = withObservability("GET /api/referrals", handleGet)

async function handleGet() {
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const result = await loadParentReferralSummary(caller.context)
  if (result.ok) return NextResponse.json(result.summary, { headers: NO_STORE })
  if (result.kind === "refused") return flatError("برنامه معرفی در حال حاضر در دسترس نیست.", 500)
  return callFailureResponse(result, "برنامه معرفی در حال حاضر در دسترس نیست.")
}

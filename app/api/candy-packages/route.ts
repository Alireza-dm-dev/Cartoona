import { NextResponse } from "next/server"
import { loadCandyPackages } from "@/lib/candy-purchases/backend-purchases"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/candy-packages - the active catalog (V0.1.51: PostgreSQL through the
 * backend, the same rows create_candy_purchase_trusted prices from). Same
 * response shape and caching as before.
 */
export async function GET() {
  const packages = await loadCandyPackages()
  if (!packages) {
    return NextResponse.json(
      { error: "دریافت اطلاعات بسته‌ها انجام نشد." },
      { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    )
  }
  return NextResponse.json(
    { packages },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600", "X-Content-Type-Options": "nosniff" } },
  )
}

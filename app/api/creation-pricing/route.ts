import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createServerSupabaseClient()

  const { data: rows, error } = await supabase
    .from("creation_pricing")
    .select("pricing_key, candy_cost, is_active, updated_at")
    .eq("is_active", true)

  if (error || !rows) {
    return NextResponse.json(
      { error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  }

  const prices: Record<string, number> = {}
  const seen = new Set<string>()

  for (const row of rows) {
    if (!row.pricing_key || typeof row.pricing_key !== "string") {
      return failure()
    }
    if (row.pricing_key.trim() === "") {
      return failure()
    }
    if (seen.has(row.pricing_key)) {
      return failure()
    }
    seen.add(row.pricing_key)

    if (typeof row.candy_cost !== "number" || row.candy_cost <= 0 || !Number.isInteger(row.candy_cost)) {
      return failure()
    }

    prices[row.pricing_key] = row.candy_cost
  }

  if (Object.keys(prices).length === 0) {
    return failure()
  }

  return NextResponse.json(
    { prices },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

function failure() {
  return NextResponse.json(
    { error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

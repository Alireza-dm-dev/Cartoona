import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return NextResponse.json(
      { error: "دریافت اطلاعات بسته‌ها انجام نشد." },
      { status: 500, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    )
  }

  const { data: rows, error } = await supabase
    .from("candy_packages")
    .select("id, name, description, candy_amount, price_amount, currency, display_order")
    .eq("is_active", true)
    .order("display_order", { ascending: true })

  if (error || !rows) {
    return NextResponse.json(
      { error: "دریافت اطلاعات بسته‌ها انجام نشد." },
      { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    )
  }

  const packages = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    candyAmount: r.candy_amount,
    priceAmount: r.price_amount,
    currency: r.currency,
    displayOrder: r.display_order,
  }))

  return NextResponse.json(
    { packages },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600", "X-Content-Type-Options": "nosniff" } },
  )
}

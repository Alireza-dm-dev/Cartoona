import Link from "next/link"
import { notFound } from "next/navigation"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { CouponForm } from "@/components/admin/coupons/coupon-form"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { queryAdminCouponDetail, queryAdminCouponPackages } from "@/lib/admin/coupons/queries"
import { isUuid } from "@/lib/admin/coupons/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function AdminEditCouponPage({
  params,
}: {
  params: Promise<{ couponId: string }>
}) {
  const { couponId } = await params

  if (!isUuid(couponId)) {
    notFound()
  }

  const supabase = await createServerSupabaseClient()

  const [coupon, packages] = await Promise.all([
    queryAdminCouponDetail(supabase, couponId),
    queryAdminCouponPackages(supabase),
  ])

  if (coupon === null) {
    notFound()
  }

  return (
    <div className="mx-auto max-w-[820px]">
      <PageHeader
        title="ویرایش کد تخفیف"
        description="تغییرات روی این کد پس از ذخیره برای خریدهای جدید اعمال می‌شود."
        action={
          <Link
            href="/admin/coupons"
            className="inline-flex items-center justify-center rounded-xl border border-soft-border bg-white px-5 py-2.5 text-sm font-medium text-text-dark transition-all hover:bg-soft-border/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
          >
            بازگشت به لیست
          </Link>
        }
      />

      <Card variant="admin" className="mb-6">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🏷️</span>
          <div>
            <h3 className="font-semibold text-parent-navy">
              <span dir="ltr" className="font-mono">{coupon.code}</span>
            </h3>
            <p className="mt-1 text-sm text-text-dark/70">{coupon.name}</p>
          </div>
        </div>
      </Card>

      <CouponForm mode="edit" packages={packages ?? []} initial={coupon} />
    </div>
  )
}

import { notFound } from "next/navigation"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { CouponForm } from "@/components/admin/coupons/coupon-form"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { queryAdminCouponPackages } from "@/lib/admin/coupons/queries"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export default async function AdminNewCouponPage() {
  // V0.1.51: the backend decides the admin role on each read (null = not found / not allowed).
  const caller = await verifyParentCaller()
  if (!caller.ok) notFound()
  const context = caller.context
  const packages = await queryAdminCouponPackages(context)

  return (
    <div className="mx-auto max-w-[820px]">
      <PageHeader
        title="افزودن کد تخفیف"
        description="یک کد تخفیف جدید برای خرید بسته‌های آبنبات بسازید."
      />

      {packages === null || packages.length === 0 ? (
        <Card variant="admin">
          <p className="text-sm text-text-dark/60">
            هنوز بسته‌ای برای اعمال کد تخفیف وجود ندارد. ابتدا یک بسته آبنبات فعال بسازید.
          </p>
        </Card>
      ) : (
        <CouponForm mode="create" packages={packages} />
      )}
    </div>
  )
}

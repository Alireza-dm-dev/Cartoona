"use client"

import type { ParentCandyPurchaseSummary, PurchaseStatusLabel } from "@/lib/candy-purchases/types"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"

interface CandyPurchaseHistoryProps {
  purchases: ParentCandyPurchaseSummary[]
}

const statusConfig: Record<PurchaseStatusLabel, { label: string; variant: "warning" | "success" | "danger" | "default" }> = {
  pending: { label: "در انتظار پرداخت", variant: "warning" },
  paid: { label: "پرداخت‌شده", variant: "success" },
  failed: { label: "ناموفق", variant: "danger" },
  cancelled: { label: "لغوشده", variant: "default" },
  expired: { label: "منقضی‌شده", variant: "default" },
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—"
  try {
    return new Date(dateStr).toLocaleDateString("fa-IR", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return "—"
  }
}

function currencyLabel(currency: string): string {
  return currency === "IRR" ? "ریال" : currency
}

function PriceBreakdown({ p }: { p: ParentCandyPurchaseSummary }) {
  const hasDiscount = p.discountAmount > 0
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="text-text-dark/70">
        {p.finalPriceAmount.toLocaleString("fa-IR")} {currencyLabel(p.currency)}
      </span>
      {hasDiscount && (
        <span className="text-xs text-text-dark/40 line-through">
          {p.originalPriceAmount.toLocaleString("fa-IR")} {currencyLabel(p.currency)}
        </span>
      )}
    </span>
  )
}

function CouponLine({ p }: { p: ParentCandyPurchaseSummary }) {
  if (!p.couponApplied || !p.couponCodeSnapshot) return null
  return (
    <span className="text-xs text-mint-green">
      کد تخفیف: <span dir="ltr" className="font-mono">{p.couponCodeSnapshot}</span>
      {p.couponName ? ` — ${p.couponName}` : ""}
    </span>
  )
}

export function CandyPurchaseHistory({ purchases }: CandyPurchaseHistoryProps) {
  if (purchases.length === 0) {
    return (
      <div className="mt-8">
        <h2 className="mb-4 font-brand text-lg font-bold text-text-dark">تاریخچه خرید آبنبات</h2>
        <EmptyState
          title="هنوز خریدی ثبت نشده است"
          description="پس از انتخاب یک بسته، سفارش پرداخت شما در این بخش نمایش داده می‌شود."
        />
      </div>
    )
  }

  return (
    <div className="mt-8">
      <h2 className="mb-4 font-brand text-lg font-bold text-text-dark">تاریخچه خرید آبنبات</h2>

      <div className="hidden md:block">
        <table className="w-full text-right text-sm">
          <thead>
            <tr className="border-b border-soft-border text-xs font-semibold text-text-dark/50">
              <th className="pb-3 pr-0 font-medium">بسته</th>
              <th className="pb-3 font-medium">آبنبات</th>
              <th className="pb-3 font-medium">قیمت</th>
              <th className="pb-3 font-medium">وضعیت</th>
              <th className="pb-3 font-medium">تاریخ ایجاد</th>
              <th className="pb-3 pl-0 font-medium">تاریخ پرداخت</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => {
              const cfg = statusConfig[p.status]
              return (
                <tr key={p.id} className="border-b border-soft-border/50 last:border-b-0">
                  <td className="py-3 pr-0">
                    <p className="font-medium text-text-dark">{p.packageName}</p>
                    {p.couponApplied && p.couponCodeSnapshot && (
                      <CouponLine p={p} />
                    )}
                  </td>
                  <td className="py-3 text-text-dark">{p.candyAmount.toLocaleString("fa-IR")}</td>
                  <td className="py-3">
                    <PriceBreakdown p={p} />
                  </td>
                  <td className="py-3">
                    <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
                  </td>
                  <td className="py-3 text-text-dark/50">{formatDate(p.createdAt)}</td>
                  <td className="py-3 pl-0 text-text-dark/50">{formatDate(p.paidAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:hidden">
        {purchases.map((p) => {
          const cfg = statusConfig[p.status]
          return (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between">
                <p className="font-semibold text-text-dark">{p.packageName}</p>
                <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
              </div>
              {p.couponApplied && p.couponCodeSnapshot && (
                <div className="mt-1">
                  <CouponLine p={p} />
                </div>
              )}
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-brand text-lg font-bold text-candy-pink">
                  {p.candyAmount.toLocaleString("fa-IR")}
                </span>
                <span className="text-xs text-text-dark/60">آبنبات</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2 text-xs text-text-dark/50">
                <span>{p.finalPriceAmount.toLocaleString("fa-IR")} {currencyLabel(p.currency)}</span>
                {p.discountAmount > 0 && (
                  <span className="line-through text-text-dark/30">
                    {p.originalPriceAmount.toLocaleString("fa-IR")} {currencyLabel(p.currency)}
                  </span>
                )}
              </div>
              <div className="mt-2 flex gap-4 text-xs text-text-dark/40">
                <span>ایجاد: {formatDate(p.createdAt)}</span>
                {p.paidAt && <span>پرداخت: {formatDate(p.paidAt)}</span>}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

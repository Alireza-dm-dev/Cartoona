"use client"

import { Card } from "@/components/ui/card"
import type { ParentReferralSummary } from "@/lib/referrals/types"

interface Props {
  summary: ParentReferralSummary
}

export function ReferralStatsCard({ summary }: Props) {
  const rewardPercent = Math.round(summary.program.rewardBasisPoints / 100)

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold text-text-dark/60">آمار معرفی</h2>

      <div className="mb-4">
        <p className="text-xs text-text-dark/40">تعداد معرفی‌های ثبت‌شده</p>
        <p className="text-3xl font-bold text-parent-navy">{summary.referredCount}</p>
      </div>

      <div>
        <p className="text-xs text-text-dark/40">نرخ پاداش آینده</p>
        <p className="text-lg font-semibold text-text-dark">{rewardPercent}%</p>
        <p className="mt-1 text-xs text-text-dark/40">
          پاداش آبنبات پس از راه‌اندازی سیستم پرداخت فعال خواهد شد.
        </p>
      </div>
    </Card>
  )
}

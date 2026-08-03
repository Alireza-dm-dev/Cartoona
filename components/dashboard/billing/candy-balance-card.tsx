"use client"

import { Card } from "@/components/ui/card"

interface CandyBalanceCardProps {
  balance: number
}

export function CandyBalanceCard({ balance }: CandyBalanceCardProps) {
  return (
    <Card className="flex flex-col items-center justify-center py-10 text-center">
      <span className="text-4xl" aria-hidden="true">🍬</span>
      <h2 className="mt-4 font-brand text-lg font-bold text-text-dark">
        موجودی آبنبات
      </h2>
      <p
        className="mt-2 font-brand text-5xl font-bold text-candy-pink"
        aria-live="polite"
        aria-label={`${balance.toLocaleString("fa-IR")} آبنبات`}
      >
        {balance.toLocaleString("fa-IR")}
      </p>
      <p className="mt-1 text-sm font-medium text-text-dark/60">
        آبنبات
      </p>
      <p className="mt-4 max-w-xs text-xs text-text-dark/40">
        آبنبات‌ها برای ثبت درخواست‌های ساخت محتوا استفاده می‌شوند.
      </p>
    </Card>
  )
}

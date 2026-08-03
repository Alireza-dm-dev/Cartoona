"use client"

import { useState } from "react"
import type { CandyPackageSummary } from "@/lib/candy-purchases/types"
import { Button } from "@/components/ui/button"

interface CandyPurchaseConfirmationProps {
  pkg: CandyPackageSummary
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function CandyPurchaseConfirmation({ pkg, onConfirm, onCancel }: CandyPurchaseConfirmationProps) {
  const [isPending, setIsPending] = useState(false)

  const handleConfirm = async () => {
    if (isPending) return
    setIsPending(true)
    try {
      await onConfirm()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="purchase-confirm-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h3 id="purchase-confirm-title" className="text-lg font-semibold text-text-dark">
          تأیید خرید بسته آبنبات
        </h3>

        <div className="mt-4 rounded-lg bg-soft-border/30 p-4">
          <p className="text-sm font-medium text-text-dark">{pkg.name}</p>
          <p className="mt-2 font-brand text-2xl font-bold text-candy-pink">
            {pkg.candyAmount.toLocaleString("fa-IR")} آبنبات
          </p>
          <p className="mt-1 text-xs text-text-dark/60">
            {pkg.priceAmount.toLocaleString("fa-IR")} {pkg.currency === "IRR" ? "ریال" : pkg.currency}
          </p>
        </div>

        <p className="mt-4 text-sm text-text-dark/60">
          پس از تأیید، یک سفارش پرداخت برای این بسته ایجاد می‌شود.
        </p>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            size="md"
            onClick={onCancel}
            disabled={isPending}
            autoFocus
          >
            انصراف
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleConfirm}
            disabled={isPending}
          >
            {isPending ? "در حال ایجاد..." : "ایجاد سفارش"}
          </Button>
        </div>
      </div>
    </div>
  )
}

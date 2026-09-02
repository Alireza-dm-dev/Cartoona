"use client"

import { useState, useRef } from "react"
import type { ParentCandyPurchaseSummary } from "@/lib/candy-purchases/types"
import type { CouponValidationResult } from "@/lib/coupons/types"
import { normalizeCouponCode, isValidRawCouponCode } from "@/lib/coupons/rules"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

interface PendingPurchaseCardProps {
  purchase: ParentCandyPurchaseSummary
  onCouponApplied: () => Promise<void>
}

const inputClass =
  "w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10 disabled:opacity-50"

function formatRial(amount: number): string {
  return `${amount.toLocaleString("fa-IR")} ریال`
}

export function PendingPurchaseCard({ purchase, onCouponApplied }: PendingPurchaseCardProps) {
  const [code, setCode] = useState("")
  const [isValidating, setIsValidating] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [preview, setPreview] = useState<CouponValidationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [justApplied, setJustApplied] = useState(false)

  // One stable idempotency key per apply action — reused across retries so a
  // double-click or network retry never creates a duplicate redemption.
  const applyKeyRef = useRef<string | null>(null)

  const couponLocked = purchase.couponApplied
  const paymentLocked = purchase.paymentStarted
  const controlsDisabled = couponLocked || paymentLocked
  const canValidate = !controlsDisabled && !isValidating && !isApplying && isValidRawCouponCode(code)

  async function handleValidate() {
    if (!purchase.id || controlsDisabled) return
    const normalized = normalizeCouponCode(code)
    if (!isValidRawCouponCode(normalized)) {
      setError("فرمت کد تخفیف نامعتبر است.")
      setPreview(null)
      return
    }
    setIsValidating(true)
    setError(null)
    setPreview(null)
    try {
      const resp = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchase_id: purchase.id, code: normalized }),
      })
      if (resp.status === 401) {
        window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
        return
      }
      if (resp.status === 403) {
        setError("شما اجازه استفاده از این بخش را ندارید.")
        return
      }
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setError(body?.error?.message || "بررسی کد تخفیف انجام نشد. دوباره امتحان کنید.")
        return
      }
      setPreview(body.coupon as CouponValidationResult)
    } catch {
      setError("بررسی کد تخفیف انجام نشد. دوباره امتحان کنید.")
    } finally {
      setIsValidating(false)
    }
  }

  async function handleApply() {
    if (!purchase.id || controlsDisabled) return
    if (!applyKeyRef.current) {
      applyKeyRef.current = `coupon-apply-${purchase.id}-${Math.random().toString(36).slice(2, 10)}`
    }
    const normalized = normalizeCouponCode(code)
    if (!isValidRawCouponCode(normalized)) {
      setError("فرمت کد تخفیف نامعتبر است.")
      return
    }
    setIsApplying(true)
    setError(null)
    try {
      const resp = await fetch(`/api/candy-purchases/${purchase.id}/coupon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized, idempotency_key: applyKeyRef.current }),
      })
      if (resp.status === 401) {
        window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
        return
      }
      if (resp.status === 403) {
        setError("شما اجازه استفاده از این بخش را ندارید.")
        return
      }
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        setError(body?.error?.message || "اعمال کد تخفیف انجام نشد. دوباره امتحان کنید.")
        return
      }
      setJustApplied(true)
      setPreview(null)
      setCode("")
      applyKeyRef.current = null
      await onCouponApplied()
    } catch {
      setError("اعمال کد تخفیف انجام نشد. دوباره امتحان کنید.")
    } finally {
      setIsApplying(false)
    }
  }

  function handleClear() {
    setCode("")
    setPreview(null)
    setError(null)
    applyKeyRef.current = null
  }

  const showDiscount = couponLocked || (preview !== null && preview.discountAmount > 0)
  const finalAmount = couponLocked ? purchase.finalPriceAmount : preview?.finalPriceAmount
  const discountAmount = couponLocked ? purchase.discountAmount : preview?.discountAmount
  const originalAmount = couponLocked ? purchase.originalPriceAmount : preview?.originalPriceAmount ?? purchase.priceAmount
  const isZeroFinal = finalAmount === 0

  return (
    <Card className="border-sunshine-yellow/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-brand text-lg font-bold text-text-dark">{purchase.packageName}</p>
          <p className="text-xs text-text-dark/50">
            {purchase.candyAmount.toLocaleString("fa-IR")} آبنبات
          </p>
        </div>
        <Badge variant="warning">در انتظار پرداخت</Badge>
      </div>

      <div className="mt-4 rounded-lg bg-soft-border/30 p-4 text-sm">
        <div className="flex items-center justify-between text-text-dark/60">
          <span>قیمت اصلی</span>
          <span>{formatRial(originalAmount)}</span>
        </div>
        {showDiscount && (
          <div className="mt-1 flex items-center justify-between text-mint-green">
            <span>تخفیف</span>
            <span>{discountAmount === undefined ? "—" : formatRial(discountAmount)}</span>
          </div>
        )}
        <div className="mt-1 flex items-center justify-between font-semibold text-text-dark">
          <span>مبلغ نهایی</span>
          <span>
            {finalAmount === undefined ? formatRial(originalAmount) : formatRial(finalAmount)}
          </span>
        </div>
      </div>

      {couponLocked && isZeroFinal && (
        <div role="alert" className="mt-3 rounded-lg bg-sky-blue/10 px-4 py-3 text-xs leading-relaxed text-text-dark/70">
          مبلغ نهایی این خرید صفر شده است. تکمیل این نوع خرید پس از افزودن جریان تأیید رایگان فعال خواهد شد.
        </div>
      )}

      {paymentLocked && !couponLocked && (
        <div className="mt-4 rounded-lg bg-soft-border/30 px-4 py-3 text-sm text-text-dark/60">
          فرآیند پرداخت برای این سفارش آغاز شده است و امکان اعمال کد تخفیف وجود ندارد.
        </div>
      )}

      {couponLocked ? (
        <div className="mt-4 rounded-lg bg-mint-green/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge variant="success">کد تخفیف اعمال شد</Badge>
            {justApplied && (
              <span role="status" aria-live="polite" className="text-xs text-mint-green">
                کد تخفیف با موفقیت اعمال شد.
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-text-dark">
            <span dir="ltr" className="font-mono">{purchase.couponCodeSnapshot}</span>
            {purchase.couponName ? ` — ${purchase.couponName}` : ""}
          </p>
          <p className="mt-1 text-xs text-text-dark/60">
            برای هر خرید فقط یک کد تخفیف قابل استفاده است.
          </p>
        </div>
      ) : (
        !paymentLocked && (
          <div className="mt-4">
            <label htmlFor={`coupon-code-${purchase.id}`} className="block text-sm font-medium text-text-dark">
              کد تخفیف
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id={`coupon-code-${purchase.id}`}
                type="text"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value)
                  setPreview(null)
                  setError(null)
                  applyKeyRef.current = null
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    if (canValidate) void handleValidate()
                  }
                }}
                placeholder="کد تخفیف را وارد کنید"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                className={`${inputClass} text-left`}
                disabled={controlsDisabled || isValidating || isApplying}
              />
              {code.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  onClick={handleClear}
                  disabled={isValidating || isApplying}
                >
                  پاک کردن ورودی
                </Button>
              )}
            </div>

            {preview ? (
              <div className="mt-3 rounded-lg bg-mint-green/10 px-4 py-3">
                <p className="text-sm font-medium text-mint-green">کد تخفیف معتبر است</p>
                <p className="mt-1 text-xs text-text-dark/60">
                  برای ثبت تخفیف، دکمه «اعمال کد» را انتخاب کنید.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={handleApply}
                    disabled={isApplying}
                  >
                    {isApplying ? "در حال اعمال..." : "اعمال کد"}
                  </Button>
                  {!isApplying && (
                    <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
                      انصراف
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleValidate}
                  disabled={!canValidate || isApplying}
                >
                  {isValidating ? "در حال بررسی..." : "بررسی کد"}
                </Button>
              </div>
            )}

            {error && (
              <p role="alert" aria-live="polite" className="mt-2 text-xs text-coral">
                {error}
              </p>
            )}
          </div>
        )
      )}
    </Card>
  )
}

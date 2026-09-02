"use client"

import { useState, useRef, useCallback } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { ReferralBindSuccess, ReferralApiErrorCode } from "@/lib/referrals/types"

interface Props {
  onBound: () => void
}

type FormPhase = "idle" | "confirming" | "submitting" | "success" | "error"

const CODE_PATTERN = /^CT[0-9A-F]{12}$/

export function ReferralBindingForm({ onBound }: Props) {
  const [rawCode, setRawCode] = useState("")
  const [formPhase, setFormPhase] = useState<FormPhase>("idle")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [retryAfter, setRetryAfter] = useState(0)
  const submittingRef = useRef(false)

  const normalized = rawCode
    .trim()
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .toUpperCase()

  const isValidFormat = CODE_PATTERN.test(normalized)

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    const upper = val.toUpperCase()
    setRawCode(upper)
    if (formPhase === "error") {
      setFormPhase("idle")
      setErrorMessage(null)
    }
  }

  const openConfirmation = () => {
    if (!isValidFormat) return
    setFormPhase("confirming")
    setErrorMessage(null)
  }

  const cancelConfirmation = () => {
    setFormPhase("idle")
  }

  const submitBinding = useCallback(async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const resp = await fetch("/api/referrals/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized }),
      })

      if (resp.ok) {
        const data: ReferralBindSuccess = await resp.json()
        if (data.status === "bound" || data.status === "already_bound") {
          setFormPhase("success")
          onBound()
          return
        }
      }

      if (resp.status === 429) {
        const retry = resp.headers.get("Retry-After")
        const seconds = retry ? parseInt(retry, 10) : 60
        setRetryAfter(seconds)
        setFormPhase("error")
        setErrorMessage("تعداد تلاش‌ها زیاد است. کمی بعد دوباره امتحان کنید.")
        return
      }

      let errorCode: ReferralApiErrorCode | undefined
      try {
        const errBody = await resp.json()
        if (errBody?.code) errorCode = errBody.code
      } catch { /* ignore */ }

      const message = mapErrorToMessage(errorCode)
      setFormPhase("error")
      setErrorMessage(message)
    } catch {
      setFormPhase("error")
      setErrorMessage("ثبت کد معرف انجام نشد. دوباره امتحان کنید.")
    } finally {
      setIsSubmitting(false)
      submittingRef.current = false
    }
  }, [normalized, onBound])

  if (formPhase === "success") {
    return null
  }

  return (
    <Card className="mb-6">
      <h2 className="mb-4 text-sm font-semibold text-text-dark/60">ثبت کد معرف</h2>

      <label htmlFor="referral-code-input" className="mb-1 block text-sm font-medium text-text-dark">
        کد معرف
      </label>
      <input
        id="referral-code-input"
        type="text"
        dir="ltr"
        placeholder="CTXXXXXXXXXXXX"
        value={rawCode}
        onChange={handleInputChange}
        maxLength={14}
        disabled={isSubmitting}
        className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark placeholder:text-text-dark/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy disabled:opacity-50"
        aria-describedby="referral-helper"
      />
      <p id="referral-helper" className="mt-1 text-xs text-text-dark/40">
        ثبت کد معرف دائمی است و بعداً قابل تغییر نخواهد بود.
      </p>

      {errorMessage && (
        <div role="alert" className="mt-3 rounded-lg bg-coral/10 px-4 py-2 text-sm text-coral">
          {errorMessage}
        </div>
      )}

      <div className="mt-4">
        <Button
          variant="primary"
          size="md"
          disabled={!isValidFormat || isSubmitting || retryAfter > 0}
          onClick={openConfirmation}
        >
          {isSubmitting ? "در حال ثبت..." : "ثبت کد معرف"}
        </Button>
      </div>

      {formPhase === "confirming" && (
        <ConfirmationDialog
          code={normalized}
          onConfirm={submitBinding}
          onCancel={cancelConfirmation}
          isSubmitting={isSubmitting}
        />
      )}
    </Card>
  )
}

function ConfirmationDialog({
  code,
  onConfirm,
  onCancel,
  isSubmitting,
}: {
  code: string
  onConfirm: () => void
  onCancel: () => void
  isSubmitting: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h3 id="confirm-title" className="text-lg font-semibold text-text-dark">
          ثبت دائمی کد معرف
        </h3>
        <p className="mt-2 text-sm text-text-dark/60">
          پس از ثبت، کد معرف این حساب قابل تغییر یا حذف نیست. از درست بودن کد مطمئن شوید.
        </p>

        <div className="mt-4 rounded-lg bg-soft-border/30 p-4 text-center">
          <code dir="ltr" className="text-lg font-bold tracking-widest text-parent-navy">
            {code}
          </code>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            size="md"
            onClick={onCancel}
            disabled={isSubmitting}
            autoFocus
          >
            انصراف
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onConfirm}
            disabled={isSubmitting}
          >
            {isSubmitting ? "در حال ثبت..." : "تأیید و ثبت کد"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function mapErrorToMessage(code: ReferralApiErrorCode | undefined): string {
  switch (code) {
    case "REFERRAL_CODE_INVALID":
      return "کد معرف نامعتبر است."
    case "REFERRAL_ALREADY_BOUND":
      return "کد معرف این حساب قبلاً ثبت شده است."
    case "REFERRAL_PROGRAM_DISABLED":
      return "برنامه معرفی در حال حاضر فعال نیست."
    case "REFERRAL_RATE_LIMITED":
      return "تعداد تلاش‌ها زیاد است. کمی بعد دوباره امتحان کنید."
    case "PARENT_PROFILE_NOT_FOUND":
      return "برای استفاده از برنامه معرفی، ابتدا پروفایل والد را کامل کنید."
    case "PARENT_SESSION_EXPIRED":
      return "برای ادامه دوباره وارد حساب خود شوید."
    default:
      return "ثبت کد معرف انجام نشد. دوباره امتحان کنید."
  }
}

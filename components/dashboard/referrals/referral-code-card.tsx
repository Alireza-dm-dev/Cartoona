"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { ParentReferralSummary } from "@/lib/referrals/types"

interface Props {
  summary: ParentReferralSummary
}

export function ReferralCodeCard({ summary }: Props) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [shareFeedback, setShareFeedback] = useState<string | null>(null)

  const code = summary.referralCode

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopyFeedback("کد معرفی کپی شد.")
    } catch {
      setCopyFeedback("کپی کد انجام نشد.")
    }
    setTimeout(() => setCopyFeedback(null), 3000)
  }

  const handleShare = async () => {
    const shareText = `من از کارتوونا استفاده می‌کنم. هنگام ثبت کد معرف، این کد را وارد کن: ${code}`

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text: shareText })
        return
      } catch {
        // user cancelled or share failed — fall through to fallback
      }
    }

    try {
      await navigator.clipboard.writeText(shareText)
      setShareFeedback("متن اشتراک‌گذاری کپی شد.")
    } catch {
      setShareFeedback("کپی متن انجام نشد.")
    }
    setTimeout(() => setShareFeedback(null), 3000)
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-text-dark/60">کد معرفی شما</h2>
      <div className="flex flex-wrap items-center gap-3">
        <code
          dir="ltr"
          className="rounded-lg bg-soft-border/40 px-4 py-2 text-lg font-bold tracking-widest text-parent-navy"
        >
          {code}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={handleCopy} aria-label="کپی کد معرفی">
            {copyFeedback ? "✓" : "📋 کپی"}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleShare} aria-label="اشتراک‌گذاری کد معرفی">
            {shareFeedback ? "✓" : "📤 اشتراک"}
          </Button>
        </div>
      </div>

      <div aria-live="polite" className="mt-2">
        {copyFeedback && (
          <p className="text-xs text-mint-green">{copyFeedback}</p>
        )}
        {shareFeedback && (
          <p className="text-xs text-mint-green">{shareFeedback}</p>
        )}
      </div>

      <p className="mt-3 text-xs text-text-dark/40">
        این کد متعلق به شماست و هنگام ثبت‌نام یا در بخش معرفی در حساب کارتونا قابل استفاده است.
      </p>
    </Card>
  )
}

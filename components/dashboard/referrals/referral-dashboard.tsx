"use client"

import { useState, useEffect, useRef } from "react"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { SafetyNotice } from "@/components/ui/safety-notice"
import type { ParentReferralSummary } from "@/lib/referrals/types"
import { ReferralCodeCard } from "./referral-code-card"
import { ReferralStatsCard } from "./referral-stats-card"
import { ReferralBindingForm } from "./referral-binding-form"

type PagePhase = "loading" | "success" | "error"

export function ReferralDashboard() {
  const [phase, setPhase] = useState<PagePhase>("loading")
  const [summary, setSummary] = useState<ParentReferralSummary | null>(null)
  const initRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    doLoad(setPhase, setSummary)
  }, [])

  function handleBound() {
    setPhase("loading")
    doLoad(setPhase, setSummary)
  }

  function handleRetry() {
    setPhase("loading")
    doLoad(setPhase, setSummary)
  }

  return (
    <div>
      <PageHeader
        title="معرفی دوستان"
        description="کد معرفی خود را با دوستانتان به اشتراک بگذارید و وضعیت معرفی‌های خود را ببینید."
      />

      <Card variant="admin" className="mb-8 border-parent-navy/20 bg-parent-navy/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">ℹ️</span>
          <div>
            <p className="text-sm text-text-dark/70">
              در حال حاضر امکان ثبت و اشتراک‌گذاری کد معرف فعال است. پاداش آبنبات پس از راه‌اندازی پرداخت‌ها فعال می‌شود.
            </p>
          </div>
        </div>
      </Card>

      {phase === "loading" && <LoadingSkeleton />}

      {phase === "error" && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-soft-border bg-white p-12 text-center">
          <p className="text-sm text-text-dark/60">اطلاعات معرفی در حال حاضر در دسترس نیست.</p>
          <Button variant="secondary" onClick={handleRetry}>تلاش دوباره</Button>
        </div>
      )}

      {phase === "success" && summary && (
        <>
          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <ReferralCodeCard summary={summary} />
            <ReferralStatsCard summary={summary} />
          </div>

          {summary.program.isEnabled && !summary.binding.isBound && (
            <ReferralBindingForm onBound={handleBound} />
          )}

          {!summary.program.isEnabled && (
            <Card variant="admin" className="border-soft-border">
              <p className="text-sm text-text-dark/60">
                برنامه معرفی در حال حاضر فعال نیست. کدها و معرفی‌های قبلی محفوظ می‌مانند.
              </p>
            </Card>
          )}

          {summary.binding.isBound && (
            <BoundStateCard summary={summary} />
          )}

          <div className="mt-8">
            <SafetyNotice title="حریم خصوصی">
              هیچ‌یک از اطلاعات هویتی والدین دیگر (نام، شماره تماس، آدرس ایمیل) در این صفحه نمایش داده نمی‌شود.
            </SafetyNotice>
          </div>
        </>
      )}
    </div>
  )
}

async function doLoad(
  setPhase: (p: PagePhase) => void,
  setSummary: (s: ParentReferralSummary | null) => void,
) {
  try {
    const resp = await fetch("/api/referrals", { cache: "no-store" })
    if (resp.status === 401) {
      window.location.href = "/login?reason=session_expired&from=/dashboard/referrals"
      return
    }
    if (resp.status === 403) {
      window.location.href = "/login?from=/dashboard/referrals"
      return
    }
    if (!resp.ok) {
      setPhase("error")
      return
    }
    const data: ParentReferralSummary = await resp.json()
    setSummary(data)
    setPhase("success")
  } catch {
    setPhase("error")
  }
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="h-48 animate-pulse rounded-xl border border-soft-border bg-white p-6" />
      <div className="h-48 animate-pulse rounded-xl border border-soft-border bg-white p-6" />
    </div>
  )
}

function BoundStateCard({ summary }: { summary: ParentReferralSummary }) {
  let dateStr = ""
  if (summary.binding.boundAt) {
    try {
      const d = new Date(summary.binding.boundAt)
      dateStr = d.toLocaleDateString("fa-IR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    } catch {
      dateStr = ""
    }
  }

  return (
    <Card className="mt-6 border-mint-green/30 bg-mint-green/5">
      <div className="flex items-center gap-3">
        <span className="text-2xl" aria-hidden="true">✅</span>
        <div>
          <h3 className="font-semibold text-text-dark">کد معرف ثبت شده است</h3>
          <p className="mt-1 text-sm text-text-dark/60">
            کد معرف این حساب به‌صورت دائمی ثبت شده و قابل تغییر نیست.
          </p>
          {dateStr && (
            <p className="mt-1 text-xs text-text-dark/40">تاریخ ثبت: {dateStr}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

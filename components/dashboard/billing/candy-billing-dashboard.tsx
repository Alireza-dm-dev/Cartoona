"use client"

import { useState, useEffect, useRef } from "react"
import { WelcomeCreditsNote } from "./welcome-credits-note"
import { RATE_LIMITED_MESSAGE } from "@/lib/rate-limit/messages";
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/neu-button"
import { CandyBalanceCard } from "./candy-balance-card"
import { CandyPackageCard } from "./candy-package-card"
import { CandyPurchaseConfirmation } from "./candy-purchase-confirmation"
import { CandyPurchaseHistory } from "./candy-purchase-history"
import { PendingPurchaseCard } from "./pending-purchase-card"
import type {
  CandyPackageSummary,
  ParentCandyBillingResponse,
  CandyPurchaseCreateResponse,
  CandyBillingDashboardPhase,
} from "@/lib/candy-purchases/types"
import { loadBilling, refreshBillingData } from "@/lib/candy-purchases/billing-client"
import { mintSubmissionKey } from "@/lib/requests/submission-attempt"

/** Display hint the payment return route adds; the shown state is always re-read from the server. */
const PAYMENT_HINTS: Record<string, { tone: "ok" | "error" | "info"; text: string }> = {
  paid: { tone: "ok", text: "پرداخت با موفقیت انجام شد و آبنبات‌ها به کیف پول اضافه شدند." },
  failed: { tone: "error", text: "پرداخت ناموفق بود. می‌توانید دوباره تلاش کنید." },
  pending: { tone: "info", text: "در انتظار تأیید پرداخت. وضعیت چند لحظه بعد به‌روز می‌شود." },
  unknown: { tone: "info", text: "وضعیت پرداخت هنوز مشخص نیست. لطفاً چند لحظه بعد صفحه را بررسی کنید." },
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="mb-6 h-32 animate-pulse neu-raised rounded-[24px] p-6" />
      <div className="mb-6 grid gap-6 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 animate-pulse neu-raised rounded-[24px] p-6" />
        ))}
      </div>
    </div>
  )
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="neu-raised flex flex-col items-center gap-4 rounded-[24px] p-12 text-center">
      <p className="text-sm text-text-dark/60">دریافت اطلاعات انجام نشد.</p>
      <Button variant="secondary" onClick={onRetry}>تلاش دوباره</Button>
    </div>
  )
}

export function CandyBillingDashboard() {
  const [phase, setPhase] = useState<CandyBillingDashboardPhase>("loading")
  const [packages, setPackages] = useState<CandyPackageSummary[]>([])
  const [billingData, setBillingData] = useState<ParentCandyBillingResponse | null>(null)
  const [selectedPkg, setSelectedPkg] = useState<CandyPackageSummary | null>(null)
  const [purchaseError, setPurchaseError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [paymentNotice, setPaymentNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null)
  /** One idempotency key per purchase's pay action, reused on a retry: never a second attempt by accident. */
  const payKeys = useRef(new Map<string, string>())
  const initRef = useRef(false)
  const creatingRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    const hint = new URLSearchParams(window.location.search).get("payment")
    if (hint && PAYMENT_HINTS[hint]) {
      window.history.replaceState(null, "", window.location.pathname)
      // Deferred like loadAll's own state updates (no synchronous setState in the effect).
      window.setTimeout(() => setPaymentNotice(PAYMENT_HINTS[hint]), 0)
    }
    loadAll().then(() => {
      // A provider confirmation may land a moment after the browser returns: re-read a few times.
      if (hint === "pending" || hint === "unknown") {
        let tries = 0
        const timer = window.setInterval(async () => {
          tries += 1
          const refreshed = await refreshBillingData()
          if (refreshed) setBillingData(refreshed)
          if (tries >= 5) window.clearInterval(timer)
        }, 2000)
      }
    })
  }, [])

  async function loadAll() {
    setPhase("loading")
    setPurchaseError(null)
    setSuccessMessage(null)
    const result = await loadBilling()

    if (result.kind === "session_expired") {
      window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
      return
    }
    if (result.kind === "forbidden") {
      window.location.href = "/login?from=/dashboard/billing"
      return
    }
    if (result.kind === "error") {
      setPhase("error")
      return
    }

    setPackages(result.packages)
    setBillingData(result.billing)
    setPhase("success")
  }

  function handleSelectPackage(pkg: CandyPackageSummary) {
    setSelectedPkg(pkg)
    setPurchaseError(null)
    setSuccessMessage(null)
  }

  function handleCancelPurchase() {
    setSelectedPkg(null)
  }

  async function refreshBilling() {
    const refreshed = await refreshBillingData()
    if (refreshed) setBillingData(refreshed)
  }

  async function handleConfirmPurchase() {
    if (!selectedPkg || creatingRef.current) return
    creatingRef.current = true
    setIsCreating(true)
    setPurchaseError(null)
    setSuccessMessage(null)

    try {
      const resp = await fetch("/api/candy-purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package_id: selectedPkg.id }),
      })

      if (resp.status === 401) {
        window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
        return
      }
      if (resp.status === 403) {
        setPurchaseError("شما اجازه استفاده از این بخش را ندارید.")
        return
      }

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}))
        if (resp.status === 404) {
          setPurchaseError("این بسته در حال حاضر در دسترس نیست.")
        } else if (resp.status === 429) {
          setPurchaseError(RATE_LIMITED_MESSAGE)
        } else {
          setPurchaseError(errBody.error || "ایجاد سفارش پرداخت انجام نشد. دوباره امتحان کنید.")
        }
        return
      }

      await resp.json() as CandyPurchaseCreateResponse
      setSelectedPkg(null)
      setSuccessMessage("سفارش پرداخت ایجاد شد.")

      await refreshBilling()
    } catch {
      setPurchaseError("ایجاد سفارش پرداخت انجام نشد. دوباره امتحان کنید.")
    } finally {
      setIsCreating(false)
      creatingRef.current = false
    }
  }

  async function handlePay(purchaseId: string) {
    if (payingId) return
    setPayingId(purchaseId)
    setPurchaseError(null)
    setSuccessMessage(null)
    let key = payKeys.current.get(purchaseId)
    if (!key) {
      key = mintSubmissionKey()
      payKeys.current.set(purchaseId, key)
    }
    try {
      const resp = await fetch(`/api/candy-purchases/${purchaseId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: key }),
      })
      if (resp.status === 401) {
        window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
        return
      }
      const body = await resp.json().catch(() => ({}))
      if (resp.ok && typeof body.checkoutUrl === "string") {
        window.location.assign(body.checkoutUrl)
        return
      }
      setPurchaseError(
        resp.status === 429
          ? RATE_LIMITED_MESSAGE
          : typeof body?.error?.message === "string" ? body.error.message : "شروع پرداخت انجام نشد. لطفاً دوباره تلاش کنید.",
      )
      setPayingId(null)
      await refreshBilling()
    } catch {
      setPurchaseError("شروع پرداخت انجام نشد. لطفاً دوباره تلاش کنید.")
      setPayingId(null)
    }
  }

  const pendingPurchases = billingData?.purchases.filter((p) => p.status === "pending" || p.status === "failed") || []

  return (
    <div>
      <PageHeader
        title="آبنبات و پرداخت"
        description="موجودی آبنبات خود را ببینید و بسته مناسب را برای ساخت تصویر و ویدیو انتخاب کنید."
      />

      {paymentNotice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${paymentNotice.tone === "ok" ? "bg-mint-green/15 text-mint-green" : paymentNotice.tone === "error" ? "bg-coral/10 text-coral" : "bg-sky-blue/10 text-text-dark/70"}`}
        >
          {paymentNotice.text}
        </div>
      )}

      {phase === "loading" && <LoadingSkeleton />}

      {phase === "error" && <ErrorCard onRetry={loadAll} />}

      {phase === "success" && billingData && (
        <>
          <div className="mb-6">
            <CandyBalanceCard balance={billingData.wallet.balance} />
          </div>

          {typeof billingData.welcomeImageCreditsRemaining === "number" &&
            billingData.welcomeImageCreditsRemaining > 0 && (
              <div className="mb-6">
                <WelcomeCreditsNote remaining={billingData.welcomeImageCreditsRemaining} />
              </div>
            )}

          {packages.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-4 font-brand text-lg font-bold text-text-dark">بسته‌های آبنبات</h2>
              <div className="grid gap-4 md:grid-cols-3">
                {packages.map((pkg) => (
                  <CandyPackageCard
                    key={pkg.id}
                    pkg={pkg}
                    onSelect={handleSelectPackage}
                    disabled={isCreating}
                  />
                ))}
              </div>
            </div>
          )}

          {packages.length === 0 && (
            <Card className="mb-6 p-8 text-center">
              <p className="text-sm text-text-dark/60">در حال حاضر بسته‌ای برای خرید وجود ندارد.</p>
            </Card>
          )}

          {pendingPurchases.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-4 font-brand text-lg font-bold text-text-dark">سفارش‌های در انتظار پرداخت</h2>
              <div className="grid gap-4 md:grid-cols-2">
                {pendingPurchases.map((p) => (
                  <PendingPurchaseCard
                    key={p.id}
                    purchase={p}
                    onCouponApplied={async () => {
                      setSuccessMessage("کد تخفیف با موفقیت اعمال شد.")
                      await refreshBilling()
                    }}
                    onPay={handlePay}
                    paying={payingId === p.id}
                  />
                ))}
              </div>
            </div>
          )}

          {successMessage && (
            <div role="alert" className="mb-4 rounded-lg bg-mint-green/15 px-4 py-3 text-sm text-mint-green">
              {successMessage}
            </div>
          )}

          {purchaseError && (
            <div role="alert" className="mb-4 rounded-lg bg-coral/10 px-4 py-3 text-sm text-coral">
              {purchaseError}
            </div>
          )}

          <CandyPurchaseHistory purchases={billingData.purchases} />
        </>
      )}

      {selectedPkg && (
        <CandyPurchaseConfirmation
          pkg={selectedPkg}
          onConfirm={handleConfirmPurchase}
          onCancel={handleCancelPurchase}
        />
      )}

    </div>
  )
}

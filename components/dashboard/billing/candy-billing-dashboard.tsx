"use client"

import { useState, useEffect, useRef } from "react"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { CandyBalanceCard } from "./candy-balance-card"
import { CandyPackageCard } from "./candy-package-card"
import { CandyPurchaseConfirmation } from "./candy-purchase-confirmation"
import { CandyPurchaseHistory } from "./candy-purchase-history"
import { PendingPurchaseCard } from "./pending-purchase-card"
import type {
  CandyPackageSummary,
  ParentCandyBillingResponse,
  CandyPurchaseCreateResponse,
  CandyPurchaseCompleteResponse,
  CandyBillingDashboardPhase,
} from "@/lib/candy-purchases/types"

function LoadingSkeleton() {
  return (
    <div>
      <div className="mb-6 h-32 animate-pulse rounded-[24px] border border-soft-border bg-white p-6" />
      <div className="mb-6 grid gap-6 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 animate-pulse rounded-[24px] border border-soft-border bg-white p-6" />
        ))}
      </div>
    </div>
  )
}

function DevNotice() {
  return (
    <Card variant="admin" className="mb-6 border-sunshine-yellow/40 bg-sunshine-yellow/10">
      <div className="flex items-start gap-3">
        <span className="text-xl" aria-hidden="true">🧪</span>
        <div>
          <p className="text-sm text-text-dark/70">
            پرداخت آزمایشی فقط برای محیط توسعه فعال است و پرداخت واقعی محسوب نمی‌شود.
          </p>
        </div>
      </div>
    </Card>
  )
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-[24px] border border-soft-border bg-white p-12 text-center">
      <p className="text-sm text-text-dark/60">دریافت اطلاعات انجام نشد.</p>
      <Button variant="secondary" onClick={onRetry}>تلاش دوباره</Button>
    </div>
  )
}

interface CandyBillingDashboardProps {
  enableDevPaymentSimulation: boolean
}

export function CandyBillingDashboard({ enableDevPaymentSimulation }: CandyBillingDashboardProps) {
  const [phase, setPhase] = useState<CandyBillingDashboardPhase>("loading")
  const [packages, setPackages] = useState<CandyPackageSummary[]>([])
  const [billingData, setBillingData] = useState<ParentCandyBillingResponse | null>(null)
  const [selectedPkg, setSelectedPkg] = useState<CandyPackageSummary | null>(null)
  const [purchaseError, setPurchaseError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [completionConfirmId, setCompletionConfirmId] = useState<string | null>(null)
  const initRef = useRef(false)
  const creatingRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    loadAll()
  }, [])

  async function loadAll() {
    setPhase("loading")
    setPurchaseError(null)
    setSuccessMessage(null)
    try {
      const [pkgResp, billingResp] = await Promise.all([
        fetch("/api/candy-packages", { cache: "no-store" }),
        fetch("/api/candy-purchases", { cache: "no-store" }),
      ])

      if (pkgResp.status === 401 || billingResp.status === 401) {
        window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
        return
      }
      if (pkgResp.status === 403 || billingResp.status === 403) {
        window.location.href = "/login?from=/dashboard/billing"
        return
      }

      if (!pkgResp.ok || !billingResp.ok) {
        setPhase("error")
        return
      }

      const pkgData = await pkgResp.json()
      const billingDataParsed: ParentCandyBillingResponse = await billingResp.json()

      setPackages(pkgData.packages || [])
      setBillingData(billingDataParsed)
      setPhase("success")
    } catch {
      setPhase("error")
    }
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
    const billingResp = await fetch("/api/candy-purchases", { cache: "no-store" })
    if (billingResp.ok) {
      const billingDataParsed: ParentCandyBillingResponse = await billingResp.json()
      setBillingData(billingDataParsed)
    }
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

  async function handleCompletePurchase(purchaseId: string) {
    setCompletionConfirmId(null)
    setCompletingId(purchaseId)
    setSuccessMessage(null)
    setPurchaseError(null)

    try {
      const resp = await fetch(`/api/candy-purchases/${purchaseId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      if (resp.status === 401) {
        window.location.href = "/login?reason=session_expired&from=/dashboard/billing"
        return
      }
      if (resp.status === 403) {
        const errBody = await resp.json().catch(() => ({}))
        if (errBody.error) {
          setPurchaseError(errBody.error)
        } else {
          setPurchaseError("شما اجازه استفاده از این بخش را ندارید.")
        }
        return
      }

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}))
        if (resp.status === 409) {
          setPurchaseError("این سفارش قبلاً پرداخت شده است.")
        } else {
          setPurchaseError(errBody.error || "تکمیل پرداخت آزمایشی انجام نشد.")
        }
        return
      }

      const data: CandyPurchaseCompleteResponse = await resp.json()
      setSuccessMessage("پرداخت آزمایشی تکمیل شد و آبنبات‌ها به کیف پول اضافه شدند.")

      await refreshBilling()
    } catch {
      setPurchaseError("تکمیل پرداخت آزمایشی انجام نشد.")
    } finally {
      setCompletingId(null)
    }
  }

  const pendingPurchases = billingData?.purchases.filter((p) => p.status === "pending") || []

  return (
    <div>
      <PageHeader
        title="آبنبات و پرداخت"
        description="موجودی آبنبات خود را ببینید و بسته مناسب را برای ساخت تصویر و ویدیو انتخاب کنید."
      />

      {enableDevPaymentSimulation && <DevNotice />}

      {phase === "loading" && <LoadingSkeleton />}

      {phase === "error" && <ErrorCard onRetry={loadAll} />}

      {phase === "success" && billingData && (
        <>
          <div className="mb-6">
            <CandyBalanceCard balance={billingData.wallet.balance} />
          </div>

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

          {enableDevPaymentSimulation && pendingPurchases.length > 0 && (
            <Card className="mb-6 border-sunshine-yellow/30">
              <h3 className="mb-3 text-sm font-semibold text-text-dark/60">تکمیل آزمایشی پرداخت</h3>
              <div className="space-y-3">
                {pendingPurchases.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border border-soft-border bg-soft-border/20 p-3">
                    <div>
                      <p className="text-sm font-medium text-text-dark">{p.packageName}</p>
                      <p className="text-xs text-text-dark/50">
                        {p.candyAmount.toLocaleString("fa-IR")} آبنبات — {p.finalPriceAmount.toLocaleString("fa-IR")} ریال
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-sunshine-yellow/30 px-1.5 py-0.5 text-xs font-medium text-parent-navy">آزمایشی</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={completingId === p.id}
                        onClick={() => setCompletionConfirmId(p.id)}
                      >
                        {completingId === p.id ? "در حال تکمیل..." : "تکمیل آزمایشی پرداخت"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
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

      {completionConfirmId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dev-complete-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
            <h3 id="dev-complete-title" className="text-lg font-semibold text-text-dark">
              تکمیل آزمایشی پرداخت
            </h3>
            <p className="mt-2 text-sm text-text-dark/60">
              این عملیات فقط برای تست توسعه است و پرداخت واقعی انجام نمی‌دهد.
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                size="md"
                onClick={() => setCompletionConfirmId(null)}
                disabled={completingId !== null}
                autoFocus
              >
                انصراف
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={() => handleCompletePurchase(completionConfirmId)}
                disabled={completingId !== null}
              >
                {completingId !== null ? "در حال تکمیل..." : "تأیید و تکمیل"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

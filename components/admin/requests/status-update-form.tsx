"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { OrderStatus } from "@/types/app"
import { mapOrderStatusLabel, STATUS_REQUIRES_REASON } from "@/lib/admin/requests/workflow"

interface StatusUpdateFormProps {
  requestId: string
  currentStatus: OrderStatus | null
  expectedUpdatedAt: string
  allowedNext: OrderStatus[]
}

const FIELD_CLASS =
  "w-full rounded-xl border border-soft-border bg-white px-3.5 py-2.5 text-sm text-text-dark transition-colors focus:border-parent-navy focus:outline-none"

/**
 * Controlled status change. The browser only sends the target status plus the
 * current updated_at (optimistic concurrency). Transition validity is enforced
 * server-side (workflow.ts) and again inside update_order_status_trusted.
 */
export function StatusUpdateForm({
  requestId,
  currentStatus,
  expectedUpdatedAt,
  allowedNext,
}: StatusUpdateFormProps) {
  const router = useRouter()
  const [target, setTarget] = useState<OrderStatus | null>(null)
  const [internalNote, setInternalNote] = useState("")
  const [parentVisibleNote, setParentVisibleNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const currentLabel = currentStatus ? mapOrderStatusLabel(currentStatus) : "وضعیت نامشخص"

  async function handleSubmit() {
    setError(null)
    setFieldError(null)

    if (!target) {
      setFieldError("یک وضعیت مقصد انتخاب کنید.")
      return
    }

    if (
      STATUS_REQUIRES_REASON.has(target) &&
      internalNote.trim() === "" &&
      parentVisibleNote.trim() === ""
    ) {
      setFieldError("برای رد درخواست، حداقل یک یادداشت (داخلی یا قابل مشاهده برای والد) وارد کنید.")
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: target,
          expectedUpdatedAt,
          internalNote: internalNote.trim() || null,
          parentVisibleNote: parentVisibleNote.trim() || null,
        }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "ذخیره تغییر وضعیت انجام نشد.")
        return
      }

      setTarget(null)
      setInternalNote("")
      setParentVisibleNote("")
      router.refresh()
    } catch {
      setError("ذخیره تغییر وضعیت انجام نشد. لطفاً دوباره تلاش کنید.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card variant="admin">
      <div className="mb-4">
        <h2 className="font-semibold text-parent-navy">مدیریت وضعیت</h2>
        <p className="mt-1 text-sm text-text-dark/60">
          وضعیت فعلی: <span className="font-medium text-text-dark">{currentLabel}</span>
        </p>
      </div>

      {allowedNext.length === 0 ? (
        <p className="rounded-lg border border-soft-border bg-soft-border/20 px-3 py-2.5 text-sm text-text-dark/60">
          {currentStatus === "delivered" || currentStatus === "rejected" || currentStatus === "cancelled"
            ? "این درخواست به وضعیت نهایی رسیده است و امکان تغییر ندارد."
            : "این وضعیت در گردش کاری قابل تغییر نیست."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text-dark">وضعیت جدید</legend>
            <div className="flex flex-wrap gap-2">
              {allowedNext.map((s) => {
                const selected = target === s
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setTarget(s)
                      setFieldError(null)
                    }}
                    aria-pressed={selected}
                    className={`inline-flex items-center justify-center rounded-xl border px-4 py-2 text-sm font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy ${
                      selected
                        ? "border-candy-pink bg-candy-pink text-white"
                        : "border-soft-border bg-white text-text-dark hover:bg-soft-border/30"
                    }`}
                  >
                    {mapOrderStatusLabel(s)}
                  </button>
                )
              })}
            </div>
            {fieldError && <p className="mt-2 text-xs text-coral">{fieldError}</p>}
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-dark">یادداشت داخلی (فقط مدیر)</span>
              <textarea
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                maxLength={2000}
                rows={3}
                className={FIELD_CLASS}
                placeholder="یادداشتی که والد نمی‌بیند..."
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-dark">متن قابل مشاهده برای والد</span>
              <textarea
                value={parentVisibleNote}
                onChange={(e) => setParentVisibleNote(e.target.value)}
                maxLength={2000}
                rows={3}
                className={FIELD_CLASS}
                placeholder="پیامی که والد در تاریخچه درخواست می‌بیند..."
              />
            </label>
          </div>

          {error && (
            <p className="rounded-lg border border-coral/20 bg-coral/5 px-3 py-2 text-sm text-coral">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <Button variant="primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "در حال ذخیره..." : "ذخیره تغییر وضعیت"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

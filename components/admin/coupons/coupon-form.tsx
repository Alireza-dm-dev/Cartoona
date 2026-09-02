"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/admin/coupons/confirm-dialog"
import type { AdminCouponCreateInput, AdminCouponDetail } from "@/lib/admin/coupons/types"
import { normalizeCouponCode } from "@/lib/coupons/rules"
import type { CouponDiscountType } from "@/types/database"

export interface CouponPackageOption {
  id: string
  name: string
  candyAmount: number
  priceAmount: number
}

type CouponFormMode = "create" | "edit"

interface FieldErrors {
  code?: string
  name?: string
  description?: string
  discountType?: string
  discountValue?: string
  startsAt?: string
  expiresAt?: string
  globalUsageLimit?: string
  perParentUsageLimit?: string
  minimumPurchaseAmount?: string
  maximumDiscountAmount?: string
  packageIds?: string
}

interface CouponFormProps {
  mode: CouponFormMode
  packages: CouponPackageOption[]
  initial?: AdminCouponDetail
}

interface ConfirmAction {
  kind: "deactivate" | "usage-limit" | "package-change"
  title: string
  description: string
}

function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ""
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return ""
  }
}

function toIso(local: string | null | undefined): string | null {
  if (!local) return null
  const d = new Date(local)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

const numberFields = [
  "globalUsageLimit",
  "perParentUsageLimit",
  "minimumPurchaseAmount",
  "maximumDiscountAmount",
] as const

function parseNumber(value: string): number | null {
  if (!value.trim()) return null
  const n = Number(value.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))))
  return Number.isFinite(n) ? n : NaN
}

export function CouponForm({ mode, packages, initial }: CouponFormProps) {
  const router = useRouter()
  const [code, setCode] = useState(initial?.code ?? "")
  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [discountType, setDiscountType] = useState<CouponDiscountType>(
    initial?.discountType ?? "percentage",
  )
  const [discountValue, setDiscountValue] = useState(() => {
    if (!initial) return ""
    if (initial.discountType === "percentage") {
      return String(initial.discountValue / 100)
    }
    return String(initial.discountValue)
  })
  const [isActive, setIsActive] = useState(initial?.isActive ?? true)
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.startsAt ?? null))
  const [expiresAt, setExpiresAt] = useState(toLocalInput(initial?.expiresAt ?? null))
  const [restrictionMode, setRestrictionMode] = useState<"all" | "selected">(
    initial && initial.packageIds.length > 0 ? "selected" : "all",
  )
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>(
    initial?.packageIds ?? [],
  )
  const [limits, setLimits] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const f of numberFields) {
      const v = initial?.[f]
      map[f] = v === null || v === undefined ? "" : String(v)
    }
    return map
  })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmAction | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  const setLimit = useCallback((key: string, value: string) => {
    setLimits((prev) => ({ ...prev, [key]: value }))
  }, [])

  const togglePackage = useCallback((id: string) => {
    setSelectedPackageIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    )
  }, [])

  const normalizedCode = normalizeCouponCode(code)

  function validate(): FieldErrors {
    const e: FieldErrors = {}
    if (normalizedCode.length < 3 || normalizedCode.length > 32 || !/^[A-Z0-9_-]+$/.test(normalizedCode)) {
      e.code = "فرمت کد تخفیف معتبر نیست."
    }
    if (!name.trim()) {
      e.name = "نام داخلی الزامی است."
    } else if (name.trim().length > 120) {
      e.name = "نام داخلی حداکثر ۱۲۰ کاراکتر می‌تواند باشد."
    }
    if (discountType === "percentage") {
      const n = Number(discountValue)
      if (!discountValue || !Number.isFinite(n) || n <= 0 || n > 100) {
        e.discountValue = "درصد تخفیف باید بیشتر از صفر و حداکثر ۱۰۰ باشد."
      }
    } else {
      const n = Number(discountValue)
      if (!discountValue || !Number.isFinite(n) || n <= 0) {
        e.discountValue = "مبلغ تخفیف باید بیشتر از صفر باشد."
      }
    }
    const startIso = toIso(startsAt)
    const endIso = toIso(expiresAt)
    if (startsAt && !startIso) e.startsAt = "تاریخ شروع معتبر نیست."
    if (expiresAt && !endIso) e.expiresAt = "تاریخ پایان معتبر نیست."
    if (startIso && endIso && new Date(endIso) <= new Date(startIso)) {
      e.expiresAt = "تاریخ پایان باید بعد از تاریخ شروع باشد."
    }
    for (const f of numberFields) {
      const n = parseNumber(limits[f])
      if (limits[f].trim() && (n === null || isNaN(n))) {
        e[f] = "این مقدار باید عدد باشد."
      } else if (n !== null && n < 0) {
        e[f] = "این مقدار نمی‌تواند منفی باشد."
      }
    }
    if (restrictionMode === "selected" && selectedPackageIds.length === 0) {
      e.packageIds = "حداقل یک بسته را انتخاب کنید."
    }
    return e
  }

  function buildInput(): AdminCouponCreateInput {
    return {
      code: normalizedCode,
      name: name.trim(),
      description: description.trim() || null,
      discountType,
      discountValue: discountType === "percentage"
        ? Math.round(Number(discountValue) * 100)
        : Math.round(Number(discountValue)),
      isActive,
      startsAt: toIso(startsAt),
      expiresAt: toIso(expiresAt),
      globalUsageLimit: parseNumber(limits.globalUsageLimit),
      perParentUsageLimit: parseNumber(limits.perParentUsageLimit),
      minimumPurchaseAmount: parseNumber(limits.minimumPurchaseAmount),
      maximumDiscountAmount: parseNumber(limits.maximumDiscountAmount),
      packageIds: restrictionMode === "selected" ? selectedPackageIds : [],
    }
  }

  // ── Confirmation gating (Part 20) ──────────────────────────────────────────

  function needsDeactivationConfirm(): boolean {
    return mode === "edit" && !isActive && (initial?.isActive ?? false)
  }

  function needsUsageLimitConfirm(): boolean {
    if (mode !== "edit" || !initial) return false
    const newGlobal = parseNumber(limits.globalUsageLimit)
    if (
      newGlobal !== null &&
      initial.globalUsageLimit !== null &&
      newGlobal < initial.globalUsageLimit &&
      newGlobal < initial.redeemedCount
    ) {
      return true
    }
    return false
  }

  function needsPackageConfirm(): boolean {
    if (mode !== "edit" || !initial) return false
    if (initial.redeemedCount === 0 && initial.reservedCount === 0) return false
    const next = restrictionMode === "selected" ? selectedPackageIds : []
    const prev = initial.packageIds
    if (next.length !== prev.length) return true
    return next.some((id) => !prev.includes(id)) || prev.some((id) => !next.includes(id))
  }

  function computeConfirmAction(): ConfirmAction | null {
    if (needsDeactivationConfirm()) {
      return {
        kind: "deactivate",
        title: "غیرفعال کردن کد تخفیف",
        description:
          "این کد برای استفاده‌های جدید غیرفعال می‌شود. تخفیف‌های ثبت‌شده قبلی حذف نخواهند شد.",
      }
    }
    if (needsUsageLimitConfirm()) {
      return {
        kind: "usage-limit",
        title: "کاهش سقف استفاده",
        description:
          "سقف جدید کمتر از تعداد استفاده‌های فعلی این کد است. آیا مطمئن هستید؟",
      }
    }
    if (needsPackageConfirm()) {
      return {
        kind: "package-change",
        title: "تغییر بسته‌های مجاز",
        description:
          "این کد قبلاً استفاده شده است. تغییر بسته‌های مجاز بر رزروها و استفاده‌های قبلی تأثیری نخواهد داشت.",
      }
    }
    return null
  }

  async function submit() {
    setServerError(null)
    const fieldErrors = validate()
    setErrors(fieldErrors)
    if (Object.keys(fieldErrors).length > 0) return

    // If confirmation is pending, run the mutation instead of re-confirming.
    const input = buildInput()
    setSubmitting(true)
    try {
      if (mode === "create") {
        const res = await fetch("/api/admin/coupons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string
            errors?: FieldErrors
          } | null
          if (body?.errors) {
            setErrors(body.errors)
          }
          setServerError(body?.error ?? "ایجاد کد تخفیف انجام نشد.")
          return
        }
        router.push("/admin/coupons")
        router.refresh()
      } else if (mode === "edit" && initial) {
        const res = await fetch(`/api/admin/coupons/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input,
            expectedUpdatedAt: initial.updatedAt,
          }),
        })
        if (res.status === 409) {
          setServerError(
            "این کد توسط مدیر دیگری تغییر کرده است. اطلاعات جدید را دوباره بارگذاری کنید.",
          )
          return
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string
            errors?: FieldErrors
          } | null
          if (body?.errors) {
            setErrors(body.errors)
          }
          setServerError(body?.error ?? "ذخیره تغییرات انجام نشد.")
          return
        }
        router.push("/admin/coupons")
        router.refresh()
      }
    } catch {
      setServerError(mode === "create" ? "ایجاد کد تخفیف انجام نشد." : "ذخیره تغییرات انجام نشد.")
    } finally {
      setSubmitting(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const action = computeConfirmAction()
    if (action) {
      setPendingConfirm(action)
      return
    }
    submit()
  }

  function handleConfirm() {
    if (!pendingConfirm) return
    setConfirmLoading(true)
    submit()
      .then(() => setPendingConfirm(null))
      .finally(() => setConfirmLoading(false))
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const inputClass =
    "w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10 disabled:opacity-50"

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-8">
        {serverError && (
          <Card variant="admin" className="border-coral/20 bg-coral/5">
            <p className="text-sm text-coral" role="alert" aria-live="polite">
              {serverError}
            </p>
          </Card>
        )}

        <Card variant="admin" className="space-y-5">
          <h3 className="border-b border-soft-border pb-3 text-base font-bold text-parent-navy">
            اطلاعات اصلی
          </h3>

          <div className="space-y-2">
            <label htmlFor="coupon-code" className="block text-sm font-medium text-text-dark">
              کد تخفیف <span className="text-coral">*</span>
            </label>
            <input
              id="coupon-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="مثلاً: SUMMER50"
              dir="ltr"
              maxLength={32}
              className={inputClass}
              disabled={mode === "edit" && (initial?.redeemedCount ?? 0) > 0}
            />
            <p className="text-xs text-text-dark/50">
              {normalizedCode ? (
                <>ذخیره با فرمت: <span dir="ltr" className="font-mono">{normalizedCode}</span></>
              ) : (
                "کدها به‌صورت خودکار با حروف بزرگ ذخیره می‌شوند."
              )}
            </p>
            {errors.code && <p className="text-xs text-coral" role="alert">{errors.code}</p>}
            {mode === "edit" && (initial?.redeemedCount ?? 0) > 0 && (
              <p className="text-xs text-text-dark/40">
                این کد قبلاً استفاده شده است و کد آن قابل تغییر نیست.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="coupon-name" className="block text-sm font-medium text-text-dark">
              نام داخلی <span className="text-coral">*</span>
            </label>
            <input
              id="coupon-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً: تخفیف تابستان"
              maxLength={120}
              className={inputClass}
            />
            {errors.name && <p className="text-xs text-coral" role="alert">{errors.name}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="coupon-description" className="block text-sm font-medium text-text-dark">
              توضیحات
            </label>
            <textarea
              id="coupon-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={1000}
              className={`${inputClass} resize-y`}
            />
            {errors.description && <p className="text-xs text-coral" role="alert">{errors.description}</p>}
          </div>
        </Card>

        <Card variant="admin" className="space-y-5">
          <h3 className="border-b border-soft-border pb-3 text-base font-bold text-parent-navy">
            نوع و مقدار تخفیف
          </h3>

          <div className="space-y-2">
            <label htmlFor="coupon-discount-type" className="block text-sm font-medium text-text-dark">
              نوع تخفیف <span className="text-coral">*</span>
            </label>
            <select
              id="coupon-discount-type"
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as CouponDiscountType)}
              disabled={mode === "edit" && (initial?.redeemedCount ?? 0) > 0}
              className={inputClass}
            >
              <option value="percentage">درصدی</option>
              <option value="fixed_amount">مبلغ ثابت</option>
            </select>
            {errors.discountType && <p className="text-xs text-coral" role="alert">{errors.discountType}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="coupon-discount-value" className="block text-sm font-medium text-text-dark">
              {discountType === "percentage" ? "درصد تخفیف (۱ تا ۱۰۰)" : "مبلغ تخفیف (ریال)"}{" "}
              <span className="text-coral">*</span>
            </label>
            <input
              id="coupon-discount-value"
              type="number"
              min={discountType === "percentage" ? 1 : 1}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              dir="ltr"
              className={inputClass}
              disabled={mode === "edit" && (initial?.redeemedCount ?? 0) > 0}
            />
            {discountType === "percentage" && (
              <p className="text-xs text-text-dark/50">درصد در قالب پایه ذخیره می‌شود (۱۰۰۰ = ۱۰٪).</p>
            )}
            {discountType === "fixed_amount" && (
              <p className="text-xs text-text-dark/50">تمام مبلغ‌ها به ریال ذخیره می‌شوند.</p>
            )}
            {errors.discountValue && <p className="text-xs text-coral" role="alert">{errors.discountValue}</p>}
            {mode === "edit" && (initial?.redeemedCount ?? 0) > 0 && (
              <p className="text-xs text-text-dark/40">
                این کد قبلاً استفاده شده است و مبلغ و نوع تخفیف آن قابل تغییر نیست.
              </p>
            )}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="coupon-starts-at" className="block text-sm font-medium text-text-dark">
                شروع اعتبار
              </label>
              <input
                id="coupon-starts-at"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className={inputClass}
              />
              {errors.startsAt && <p className="text-xs text-coral" role="alert">{errors.startsAt}</p>}
            </div>
            <div className="space-y-2">
              <label htmlFor="coupon-expires-at" className="block text-sm font-medium text-text-dark">
                پایان اعتبار
              </label>
              <input
                id="coupon-expires-at"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className={inputClass}
              />
              {errors.expiresAt && <p className="text-xs text-coral" role="alert">{errors.expiresAt}</p>}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy ${
                isActive ? "bg-mint-green" : "bg-soft-border"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  isActive ? "translate-x-[22px]" : "translate-x-[3px]"
                }`}
              />
            </button>
            <label className="text-sm font-medium text-text-dark">
              فعال بودن کد
            </label>
          </div>
        </Card>

        <Card variant="admin" className="space-y-5">
          <h3 className="border-b border-soft-border pb-3 text-base font-bold text-parent-navy">
            محدودیت‌ها
          </h3>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="coupon-global-limit" className="block text-sm font-medium text-text-dark">
                حداکثر استفاده کلی
              </label>
              <input
                id="coupon-global-limit"
                type="number"
                min={1}
                value={limits.globalUsageLimit}
                onChange={(e) => setLimit("globalUsageLimit", e.target.value)}
                dir="ltr"
                className={inputClass}
                placeholder="نامحدود"
              />
              {errors.globalUsageLimit && (
                <p className="text-xs text-coral" role="alert">{errors.globalUsageLimit}</p>
              )}
            </div>
            <div className="space-y-2">
              <label htmlFor="coupon-parent-limit" className="block text-sm font-medium text-text-dark">
                حداکثر استفاده برای هر والد
              </label>
              <input
                id="coupon-parent-limit"
                type="number"
                min={1}
                value={limits.perParentUsageLimit}
                onChange={(e) => setLimit("perParentUsageLimit", e.target.value)}
                dir="ltr"
                className={inputClass}
                placeholder="نامحدود"
              />
              {errors.perParentUsageLimit && (
                <p className="text-xs text-coral" role="alert">{errors.perParentUsageLimit}</p>
              )}
            </div>
            <div className="space-y-2">
              <label htmlFor="coupon-min-purchase" className="block text-sm font-medium text-text-dark">
                حداقل مبلغ خرید (ریال)
              </label>
              <input
                id="coupon-min-purchase"
                type="number"
                min={0}
                value={limits.minimumPurchaseAmount}
                onChange={(e) => setLimit("minimumPurchaseAmount", e.target.value)}
                dir="ltr"
                className={inputClass}
                placeholder="بدون حداقل"
              />
              {errors.minimumPurchaseAmount && (
                <p className="text-xs text-coral" role="alert">{errors.minimumPurchaseAmount}</p>
              )}
            </div>
            <div className="space-y-2">
              <label htmlFor="coupon-max-discount" className="block text-sm font-medium text-text-dark">
                حداکثر مبلغ تخفیف (ریال)
              </label>
              <input
                id="coupon-max-discount"
                type="number"
                min={1}
                value={limits.maximumDiscountAmount}
                onChange={(e) => setLimit("maximumDiscountAmount", e.target.value)}
                dir="ltr"
                className={inputClass}
                placeholder="بدون سقف"
              />
              {errors.maximumDiscountAmount && (
                <p className="text-xs text-coral" role="alert">{errors.maximumDiscountAmount}</p>
              )}
            </div>
          </div>

          <p className="text-xs text-text-dark/40">تمام مبلغ‌ها به ریال ذخیره می‌شوند.</p>
        </Card>

        <Card variant="admin" className="space-y-5">
          <h3 className="border-b border-soft-border pb-3 text-base font-bold text-parent-navy">
            بسته‌های مجاز
          </h3>

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm font-medium text-text-dark">
              <input
                type="radio"
                name="restriction-mode"
                checked={restrictionMode === "all"}
                onChange={() => setRestrictionMode("all")}
                className="h-4 w-4 text-candy-pink focus:ring-candy-pink/20"
              />
              اعمال برای همه بسته‌ها
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-text-dark">
              <input
                type="radio"
                name="restriction-mode"
                checked={restrictionMode === "selected"}
                onChange={() => setRestrictionMode("selected")}
                className="h-4 w-4 text-candy-pink focus:ring-candy-pink/20"
              />
              فقط بسته‌های انتخاب‌شده
            </label>
          </div>

          {restrictionMode === "selected" && (
            <div className="grid gap-3 sm:grid-cols-2">
              {packages.map((pkg) => (
                <label
                  key={pkg.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
                    selectedPackageIds.includes(pkg.id)
                      ? "border-candy-pink/50 bg-candy-pink/5"
                      : "border-soft-border bg-white hover:bg-soft-border/20"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPackageIds.includes(pkg.id)}
                    onChange={() => togglePackage(pkg.id)}
                    className="mt-1 h-4 w-4 rounded border-soft-border text-candy-pink focus:ring-candy-pink/20"
                  />
                  <span className="text-sm">
                    <span className="block font-medium text-text-dark">{pkg.name}</span>
                    <span className="block text-xs text-text-dark/50" dir="ltr">
                      {pkg.candyAmount} 🍬 — {pkg.priceAmount} IRR
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {errors.packageIds && <p className="text-xs text-coral" role="alert">{errors.packageIds}</p>}
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting
              ? "در حال ذخیره…"
              : mode === "create"
                ? "افزودن کد تخفیف"
                : "ذخیره تغییرات"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.push("/admin/coupons")}>
            انصراف
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ""}
        description={pendingConfirm?.description ?? ""}
        confirmLabel="تأیید"
        danger={pendingConfirm?.kind === "deactivate"}
        loading={confirmLoading}
        onConfirm={handleConfirm}
        onCancel={() => setPendingConfirm(null)}
      />
    </>
  )
}

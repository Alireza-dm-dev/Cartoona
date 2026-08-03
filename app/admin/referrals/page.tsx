"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { useAdminReferrals } from "@/lib/referrals/use-admin-referrals"
import type {
  AdminReferralSettings,
  AdminReferralSettingsUpdateResponse,
  AdminReferralErrorResponse,
} from "@/lib/referrals/admin-types"

const bindingSourceLabels: Record<string, string> = {
  self_service: "خودکار توسط والد",
  admin: "ثبت دستی توسط ادمین",
  signup_code: "ثبت هنگام ثبت‌نام",
}

type PagePhase = "loading" | "success" | "error"
type EditPhase = "idle" | "editing" | "saving" | "success" | "conflict" | "error"

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return "—"
    return d.toLocaleDateString("fa-IR", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  } catch {
    return "—"
  }
}

export default function AdminReferralsPage() {
  const { data, loading, error, page, search, setSearch, setPage, refresh } = useAdminReferrals(25)

  const [editPhase, setEditPhase] = useState<EditPhase>("idle")
  const [editEnabled, setEditEnabled] = useState(false)
  const [editPercent, setEditPercent] = useState("")
  const [editMessage, setEditMessage] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState("")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)

  const settings = data?.settings ?? null
  const metrics = data?.metrics ?? null
  const relationships = data?.relationships ?? []
  const pagination = data?.pagination ?? null

  function handleSearchChange(val: string) {
    setSearchInput(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setSearch(val), 300)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const openEdit = useCallback(() => {
    if (!settings) return
    setEditEnabled(settings.isEnabled)
    setEditPercent(String(Math.round(settings.rewardBasisPoints / 100)))
    setEditPhase("editing")
    setEditMessage(null)
  }, [settings])

  const cancelEdit = useCallback(() => {
    setEditPhase("idle")
    setEditMessage(null)
  }, [])

  const saveSettings = useCallback(async () => {
    if (savingRef.current) return
    if (!settings) return

    const pct = parseInt(editPercent, 10)
    if (isNaN(pct) || pct < 0 || pct > 100) {
      setEditMessage("درصد پاداش باید بین ۰ تا ۱۰۰ باشد.")
      return
    }

    savingRef.current = true
    setEditPhase("saving")
    setEditMessage(null)

    try {
      const resp = await fetch("/api/admin/referrals/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isEnabled: editEnabled,
          rewardBasisPoints: pct * 100,
          expectedUpdatedAt: settings.updatedAt,
        }),
      })

      if (resp.ok) {
        const result: AdminReferralSettingsUpdateResponse = await resp.json()
        setEditPhase("success")
        const verb = result.status === "updated" ? "به‌روزرسانی شد." : "تغییری اعمال نشد."
        setEditMessage(`تنظیمات ${verb}`)
        refresh()
      } else {
        let errCode: string | undefined
        try {
          const errBody: AdminReferralErrorResponse = await resp.json()
          errCode = errBody.code
        } catch { /* ignore */ }

        if (resp.status === 409) {
          setEditPhase("conflict")
          setEditMessage("تنظیمات توسط مدیر دیگری تغییر کرده است. اطلاعات را دوباره بارگذاری کنید.")
        } else if (resp.status === 422) {
          setEditPhase("error")
          setEditMessage("تنظیمات برنامه معرفی معتبر نیست.")
        } else {
          setEditPhase("error")
          setEditMessage("خطا در ذخیره تنظیمات.")
        }
      }
    } catch {
      setEditPhase("error")
      setEditMessage("خطا در برقراری ارتباط. دوباره تلاش کنید.")
    } finally {
      savingRef.current = false
    }
  }, [settings, editEnabled, editPercent, refresh])

  const dismissEditSuccess = useCallback(() => {
    setEditPhase("idle")
    setEditMessage(null)
  }, [])

  const rewardPct = settings ? Math.round(settings.rewardBasisPoints / 100) : 0
  const pagePhase: PagePhase = loading ? "loading" : error ? "error" : "success"

  return (
    <div className="mx-auto max-w-[960px]">
      <PageHeader
        title="مدیریت معرفی"
        description="مشاهده و مدیریت تنظیمات برنامه معرفی، روابط ثبت‌شده و آمار کلی والدین."
      />

      <Card variant="admin" className="mb-8 border-soft-purple/20 bg-soft-purple/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🔗</span>
          <div>
            <h3 className="font-semibold text-parent-navy">برنامه معرفی دوستان</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              تنظیمات، روابط و آمار برنامه معرفی در این بخش مدیریت می‌شود.
            </p>
          </div>
        </div>
      </Card>

      {pagePhase === "loading" && (
        <div className="flex flex-col gap-6">
          <LoadingCard />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-soft-border bg-white p-6" />
            ))}
          </div>
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl border border-soft-border bg-white p-6" />
            ))}
          </div>
        </div>
      )}

      {pagePhase === "error" && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-soft-border bg-white p-12 text-center">
          <p className="text-sm text-text-dark/60">
            {error || "بارگذاری اطلاعات انجام نشد."}
          </p>
          <Button variant="secondary" onClick={refresh}>تلاش دوباره</Button>
        </div>
      )}

      {pagePhase === "success" && data && (
        <>
          {/* ── Settings card ─────────────────────────────────────────────────── */}
          <h2 className="mb-4 text-lg font-semibold text-parent-navy">تنظیمات برنامه</h2>
          <Card variant="admin" className="mb-8">
            {editPhase === "idle" || editPhase === "success" ? (
              <>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-text-dark/60">وضعیت</span>
                    <Badge variant={data.settings.isEnabled ? "success" : "default"} size="md">
                      {data.settings.isEnabled ? "فعال" : "غیرفعال"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-text-dark/60">
                    <span>نرخ پاداش:</span>
                    <span className="font-semibold text-parent-navy">{rewardPct}%</span>
                    <span className="text-xs text-text-dark/40">({data.settings.rewardBasisPoints}bps)</span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-text-dark/40">
                  آخرین به‌روزرسانی: {formatDate(data.settings.updatedAt)}
                </div>
                <div className="mt-4">
                  <Button variant="secondary" size="sm" onClick={openEdit}>
                    ویرایش تنظیمات
                  </Button>
                </div>
                {editPhase === "success" && editMessage && (
                  <div className="mt-3 rounded-lg bg-mint-green/20 px-4 py-2 text-sm text-mint-green">
                    {editMessage}
                  </div>
                )}
              </>
            ) : (
              <>
                <h3 className="mb-4 text-sm font-semibold text-text-dark">ویرایش تنظیمات</h3>

                <div className="mb-4 flex items-center gap-3">
                  <span className="text-sm text-text-dark/60">فعال بودن برنامه</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={editEnabled}
                    disabled={editPhase === "saving"}
                    onClick={() => setEditEnabled((v) => !v)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy ${
                      editEnabled ? "bg-mint-green" : "bg-soft-border"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                        editEnabled ? "translate-x-[22px]" : "translate-x-[3px]"
                      }`}
                    />
                  </button>
                  <span className="text-sm text-text-dark/60">
                    {editEnabled ? "فعال" : "غیرفعال"}
                  </span>
                </div>

                <div className="mb-4">
                  <label
                    htmlFor="reward-percent-input"
                    className="mb-1 block text-sm font-medium text-text-dark"
                  >
                    درصد پاداش (۰ تا ۱۰۰)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="reward-percent-input"
                      type="number"
                      min={0}
                      max={100}
                      value={editPercent}
                      onChange={(e) => setEditPercent(e.target.value)}
                      disabled={editPhase === "saving"}
                      className="w-32 rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark placeholder:text-text-dark/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy disabled:opacity-50"
                    />
                    <span className="text-sm text-text-dark/60">%</span>
                    <span className="text-xs text-text-dark/40">
                      ({editPercent ? String(Number(editPercent) * 100) : "۰"} bps)
                    </span>
                  </div>
                </div>

                {editMessage && (
                  <div
                    role="alert"
                    className={`mb-4 rounded-lg px-4 py-2 text-sm ${
                      editPhase === "conflict" || editPhase === "error"
                        ? "bg-coral/10 text-coral"
                        : "bg-mint-green/20 text-mint-green"
                    }`}
                  >
                    {editMessage}
                  </div>
                )}

                {editPhase === "conflict" && (
                  <div className="mb-4">
                    <Button variant="secondary" size="sm" onClick={refresh}>
                      بارگذاری مجدد
                    </Button>
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={cancelEdit}
                    disabled={editPhase === "saving"}
                  >
                    انصراف
                  </Button>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={saveSettings}
                    disabled={editPhase === "saving"}
                  >
                    {editPhase === "saving" ? "در حال ذخیره..." : "ذخیره تنظیمات"}
                  </Button>
                </div>
              </>
            )}
          </Card>

          {/* ── Metrics ──────────────────────────────────────────────────────── */}
          <h2 className="mb-4 text-lg font-semibold text-parent-navy">آمار کلی</h2>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card variant="admin">
              <p className="text-xs text-text-dark/40">پروفایل والد</p>
              <p className="mt-1 text-2xl font-bold text-parent-navy">{data.metrics.totalParentProfiles}</p>
            </Card>
            <Card variant="admin">
              <p className="text-xs text-text-dark/40">روابط معرفی ثبت‌شده</p>
              <p className="mt-1 text-2xl font-bold text-parent-navy">{data.metrics.totalRelationships}</p>
            </Card>
            <Card variant="admin">
              <p className="text-xs text-text-dark/40">والدین بدون کد معرف</p>
              <p className="mt-1 text-2xl font-bold text-coral">{data.metrics.totalUnboundParentProfiles}</p>
            </Card>
            <Card variant="admin">
              <p className="text-xs text-text-dark/40">روابط هویتی حذف‌شده</p>
              <p className="mt-1 text-2xl font-bold text-text-dark">{data.metrics.totalDeletedIdentityRelationships}</p>
            </Card>
            <Card variant="admin">
              <p className="text-xs text-text-dark/40">تغییرات تنظیمات</p>
              <p className="mt-1 text-2xl font-bold text-text-dark">{data.metrics.settingsHistoryCount}</p>
            </Card>
          </div>

          {/* ── Search & Relationships ──────────────────────────────────────── */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-parent-navy">روابط معرفی</h2>
            <div className="w-full sm:w-64">
              <input
                type="text"
                placeholder="جستجوی کد، نام یا ایمیل..."
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark placeholder:text-text-dark/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
                aria-label="جستجوی روابط معرفی"
              />
            </div>
          </div>

          {relationships.length === 0 ? (
            <EmptyState
              title={search ? "نتیجه‌ای یافت نشد" : "هیچ رابطه معرفی ثبت نشده است"}
              description={
                search
                  ? "جستجوی خود را تغییر دهید یا عبارت دیگری را امتحان کنید."
                  : "هنوز هیچ رابطه معرفی بین والدین ثبت نشده است."
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              {relationships.map((rel) => (
                <Card key={rel.id} variant="admin">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-parent-navy">{rel.id}</span>
                      <Badge variant="info" size="sm">
                        {bindingSourceLabels[rel.bindingSource] ?? rel.bindingSource}
                      </Badge>
                    </div>
                    <code
                      dir="ltr"
                      className="rounded-md bg-soft-border/30 px-2 py-0.5 text-xs font-mono text-text-dark/70"
                    >
                      {rel.referralCodeSnapshot}
                    </code>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-text-dark/50 sm:grid-cols-2">
                    <div className="flex justify-between">
                      <span>والد دعوت‌شده</span>
                      <span className="text-text-dark/70 font-medium">
                        {rel.referredParent?.name ?? rel.referredParent?.email ?? "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>والد دعوت‌کننده</span>
                      <span className="text-text-dark/70 font-medium">
                        {rel.referrerParent?.name ?? rel.referrerParent?.email ?? "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>کد دعوت‌کننده</span>
                      <span className="text-text-dark/70 font-medium font-mono" dir="ltr">
                        {rel.referrerParent?.currentCode ?? "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>تاریخ ثبت</span>
                      <span className="text-text-dark/70 font-medium">{formatDate(rel.boundAt)}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* ── Pagination ──────────────────────────────────────────────────── */}
          {pagination && pagination.totalPages > 1 && (
            <div className="mt-8 flex items-center justify-between">
              <p className="text-xs text-text-dark/40">
                صفحه {pagination.page} از {pagination.totalPages} — {pagination.total} رابطه
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(page - 1)}
                >
                  صفحه قبل
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= pagination.totalPages || loading}
                  onClick={() => setPage(page + 1)}
                >
                  صفحه بعد
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function LoadingCard() {
  return (
    <div className="h-32 animate-pulse rounded-xl border border-soft-border bg-white p-6" />
  )
}

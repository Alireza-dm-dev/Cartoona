"use client"

import { useState, useRef, useEffect } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { CouponStatusBadge } from "@/components/admin/coupons/coupon-status-badge"
import { useAdminCoupons } from "@/lib/admin/coupons/use-admin-coupons"
import {
  discountSummary,
  maximumDiscountSummary,
  usageSummary,
  reservedSummary,
  discountTypeLabels,
} from "@/lib/admin/coupons/format"
import type { AdminCouponListItem } from "@/lib/admin/coupons/types"

const statusFilterLabels: Record<string, string> = {
  all: "همه",
  active: "فعال",
  inactive: "غیرفعال",
  scheduled: "زمان‌بندی‌شده",
  expired: "منقضی‌شده",
}

const discountFilterLabels: Record<string, string> = {
  all: "همه نوع‌ها",
  percentage: "درصدی",
  fixed_amount: "مبلغ ثابت",
}

function formatCreatedAt(iso: string): string {
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

export default function AdminCouponsPage() {
  const {
    data,
    loading,
    error,
    page,
    search,
    status,
    discountType,
    setSearch,
    setStatus,
    setDiscountType,
    setPage,
    refresh,
  } = useAdminCoupons(25)

  const [searchInput, setSearchInput] = useState("")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function handleSearchChange(val: string) {
    setSearchInput(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setSearch(val), 300)
  }

  const coupons = data?.coupons ?? []
  const pagination = data?.pagination ?? null
  const hasFilters = Boolean(search) || status !== "all" || discountType !== "all"

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="کدهای تخفیف"
        description="ایجاد و مدیریت کدهای تخفیف برای خرید بسته‌های آبنبات."
        action={
          <Link
            href="/admin/coupons/new"
            className="inline-flex items-center justify-center rounded-xl bg-candy-pink px-5 py-2.5 text-sm font-medium text-white transition-all hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
          >
            + کد تخفیف جدید
          </Link>
        }
      />

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <Card variant="admin" className="mb-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="w-full lg:w-64">
            <input
              type="text"
              placeholder="جستجوی کد یا نام..."
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              aria-label="جستجوی کدهای تخفیف"
              className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark placeholder:text-text-dark/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="coupon-status-filter" className="sr-only">
              فیلتر وضعیت
            </label>
            <select
              id="coupon-status-filter"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-xl border border-soft-border bg-white px-3 py-2.5 text-sm text-text-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
            >
              {Object.entries(statusFilterLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="coupon-type-filter" className="sr-only">
              فیلتر نوع تخفیف
            </label>
            <select
              id="coupon-type-filter"
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value)}
              className="rounded-xl border border-soft-border bg-white px-3 py-2.5 text-sm text-text-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
            >
              {Object.entries(discountFilterLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {loading && (
        <div className="flex flex-col gap-4" aria-label="در حال بارگذاری">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-soft-border bg-white p-6" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-soft-border bg-white p-12 text-center">
          <p role="alert" className="text-sm text-text-dark/60">
            {error}
          </p>
          <Button variant="secondary" onClick={refresh}>
            تلاش دوباره
          </Button>
        </div>
      )}

      {!loading && !error && coupons.length === 0 && (
        hasFilters ? (
          <EmptyState
            title="کدی با این فیلتر پیدا نشد"
            description="فیلترها یا عبارت جستجو را تغییر دهید."
          />
        ) : (
          <EmptyState
            title="هنوز کد تخفیفی ایجاد نشده است"
            description="برای شروع، اولین کد تخفیف را ایجاد کنید."
            icon={<span aria-hidden="true">🏷️</span>}
            action={
              <Link
                href="/admin/coupons/new"
                className="inline-flex items-center justify-center rounded-xl bg-candy-pink px-5 py-2.5 text-sm font-medium text-white transition-all hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
              >
                افزودن کد تخفیف
              </Link>
            }
          />
        )
      )}

      {!loading && !error && coupons.length > 0 && (
        <>
          {/* ── Desktop table ─────────────────────────────────────────────── */}
          <div className="hidden overflow-hidden rounded-2xl border border-soft-border bg-white md:block">
            <table className="w-full text-right text-sm">
              <thead>
                <tr className="border-b border-soft-border bg-soft-border/20 text-xs text-text-dark/60">
                  <th scope="col" className="px-4 py-3 font-medium">کد / نام</th>
                  <th scope="col" className="px-4 py-3 font-medium">نوع تخفیف</th>
                  <th scope="col" className="px-4 py-3 font-medium">مقدار</th>
                  <th scope="col" className="px-4 py-3 font-medium">وضعیت</th>
                  <th scope="col" className="px-4 py-3 font-medium">استفاده</th>
                  <th scope="col" className="px-4 py-3 font-medium">تاریخ ایجاد</th>
                  <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">عملیات</span></th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((coupon) => (
                  <CouponTableRow key={coupon.id} coupon={coupon} />
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Mobile cards ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-4 md:hidden">
            {coupons.map((coupon) => (
              <CouponMobileCard key={coupon.id} coupon={coupon} />
            ))}
          </div>

          {/* ── Pagination ───────────────────────────────────────────────── */}
          {pagination && pagination.totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between">
              <p className="text-xs text-text-dark/40">
                صفحه {pagination.page} از {pagination.totalPages} — {pagination.total} کد
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

function CouponTableRow({ coupon }: { coupon: AdminCouponListItem }) {
  const maxSummary = maximumDiscountSummary(coupon)
  return (
    <tr className="border-b border-soft-border last:border-b-0 hover:bg-soft-border/10">
      <td className="px-4 py-3">
        <Link
          href={`/admin/coupons/${coupon.id}`}
          className="block font-semibold text-parent-navy hover:text-candy-pink"
        >
          <span dir="ltr" className="font-mono text-xs">{coupon.code}</span>
        </Link>
        <span className="block text-xs text-text-dark/50">{coupon.name}</span>
      </td>
      <td className="px-4 py-3 text-xs text-text-dark/60">
        <Badge variant="info" size="sm">{discountTypeLabels[coupon.discountType]}</Badge>
      </td>
      <td className="px-4 py-3 text-xs font-medium text-text-dark">
        <span className="block">{discountSummary(coupon)}</span>
        {maxSummary && <span className="block text-[11px] text-text-dark/40">{maxSummary}</span>}
      </td>
      <td className="px-4 py-3">
        <CouponStatusBadge status={coupon.status} />
      </td>
      <td className="px-4 py-3 text-xs text-text-dark/60">
        <span className="block">{usageSummary(coupon)}</span>
        {reservedSummary(coupon) && (
          <span className="block text-[11px] text-text-dark/40">{reservedSummary(coupon)}</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-text-dark/50">{formatCreatedAt(coupon.createdAt)}</td>
      <td className="px-4 py-3">
        <Link
          href={`/admin/coupons/${coupon.id}`}
          className="inline-flex items-center justify-center rounded-lg border border-soft-border bg-white px-3 py-1.5 text-xs font-medium text-text-dark transition-all hover:bg-soft-border/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
        >
          ویرایش
        </Link>
      </td>
    </tr>
  )
}

function CouponMobileCard({ coupon }: { coupon: AdminCouponListItem }) {
  const maxSummary = maximumDiscountSummary(coupon)
  const reserved = reservedSummary(coupon)
  return (
    <Card variant="admin">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Link
            href={`/admin/coupons/${coupon.id}`}
            className="block font-semibold text-parent-navy hover:text-candy-pink"
          >
            <span dir="ltr" className="font-mono text-sm">{coupon.code}</span>
          </Link>
          <span className="mt-0.5 block text-xs text-text-dark/50">{coupon.name}</span>
        </div>
        <CouponStatusBadge status={coupon.status} />
      </div>
      <div className="mt-3 flex flex-col gap-1.5 text-xs text-text-dark/60">
        <div className="flex justify-between">
          <span>نوع و مقدار</span>
          <span className="text-text-dark/80 font-medium">
            {discountTypeLabels[coupon.discountType]} — {discountSummary(coupon)}
          </span>
        </div>
        {maxSummary && (
          <div className="flex justify-between">
            <span>سقف تخفیف</span>
            <span className="text-text-dark/70">{maxSummary}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span>استفاده</span>
          <span className="text-text-dark/70 font-medium">{usageSummary(coupon)}</span>
        </div>
        {reserved && (
          <div className="flex justify-between">
            <span>رزرو</span>
            <span className="text-text-dark/70">{reserved}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span>تاریخ ایجاد</span>
          <span className="text-text-dark/70">{formatCreatedAt(coupon.createdAt)}</span>
        </div>
      </div>
      <div className="mt-3">
        <Link
          href={`/admin/coupons/${coupon.id}`}
          className="inline-flex items-center justify-center rounded-lg border border-soft-border bg-white px-3 py-1.5 text-xs font-medium text-text-dark transition-all hover:bg-soft-border/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
        >
          ویرایش کد تخفیف
        </Link>
      </div>
    </Card>
  )
}

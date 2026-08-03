import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { queryAdminRequestQueue } from "@/lib/admin/requests/queries";
import {
  parsePageNumber,
  parsePageSize,
  parseStatusFilter,
  parseTypeFilter,
} from "@/lib/admin/requests/validation";
import {
  KNOWN_ORDER_STATUSES,
  isKnownOrderStatus,
  mapOrderStatusLabel,
} from "@/lib/admin/requests/mappers";
import { mapStatusTone } from "@/lib/admin/requests/workflow";
import { adminRequestTypeLabels } from "@/config/admin";
import type { OrderType } from "@/types/app";

const REQUEST_TYPES: OrderType[] = ["image", "video", "drawing_animation"];

const TONE_DOT_CLASSES: Record<ReturnType<typeof mapStatusTone>, string> = {
  neutral: "bg-soft-border",
  info: "bg-sky-blue",
  active: "bg-sunshine-yellow",
  success: "bg-mint-green",
  danger: "bg-coral",
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "—";
  }
}

function buildFilterUrl(
  base: string,
  filters: { type: OrderType | null; status: string | null; page?: number },
): string {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.status) params.set("status", filters.status);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

interface QueuePageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function AdminRequestsPage({ searchParams }: QueuePageProps) {
  const sp = await searchParams;
  const type = parseTypeFilter(sp.type);
  const status = parseStatusFilter(sp.status);
  const page = parsePageNumber(sp.page);
  const pageSize = parsePageSize(sp.pageSize);

  const supabase = await createServerSupabaseClient();

  const result = await queryAdminRequestQueue(supabase, {
    type,
    status,
    page,
    pageSize,
  });

  const base = "/admin/requests";

  return (
    <div>
      <PageHeader
        title="صف درخواست‌ها"
        description="درخواست‌های ساخت تصویر، ویدیو و انیمیشن نقاشی را بررسی و مدیریت کنید."
      />

      <div className="mb-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={buildFilterUrl(base, { type: null, status: status ? status : null })}>
            <Badge variant={type === null ? "info" : "default"} size="md">
              همه
            </Badge>
          </Link>
          {REQUEST_TYPES.map((t) => (
            <Link key={t} href={buildFilterUrl(base, { type: t, status: status ? status : null })}>
              <Badge variant={type === t ? "info" : "default"} size="md">
                {adminRequestTypeLabels[t]}
              </Badge>
            </Link>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {KNOWN_ORDER_STATUSES.map((s) => (
            <Link key={s} href={buildFilterUrl(base, { type, status: s })}>
              <Badge variant={status === s ? "info" : "default"} size="sm">
                {mapOrderStatusLabel(s)}
              </Badge>
            </Link>
          ))}
          {status && (
            <Link href={buildFilterUrl(base, { type, status: null })}>
              <Badge variant="danger" size="sm">
                حذف فیلتر وضعیت
              </Badge>
            </Link>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-text-dark/50">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-sky-blue" aria-hidden="true" />
            در انتظار بررسی
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-sunshine-yellow" aria-hidden="true" />
            در حال تولید
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-mint-green" aria-hidden="true" />
            آماده / تحویل شده
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-coral" aria-hidden="true" />
            رد شده / لغو شده
          </span>
        </div>
      </div>

      {result === null ? (
        <Card variant="admin" className="border-coral/20 bg-coral/5">
          <p className="text-sm text-coral">دریافت درخواست‌ها انجام نشد.</p>
          <p className="mt-1 text-xs text-text-dark/50">لطفاً بعداً دوباره تلاش کنید.</p>
        </Card>
      ) : result.rows.length === 0 ? (
        result.hasFilters ? (
          <EmptyState
            title="درخواستی با این فیلتر پیدا نشد"
            description="فیلترها را تغییر دهید و دوباره امتحان کنید."
          />
        ) : (
          <EmptyState
            title="هنوز درخواستی ثبت نشده است"
            description="پس از ثبت درخواست توسط والدین، درخواست‌ها در این بخش نمایش داده می‌شوند."
          />
        )
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {result.rows.map((req) => (
              <Card key={req.id} variant="admin">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-parent-navy">{req.title}</h3>
                      <span dir="ltr" className="text-xs text-text-dark/40">
                        {req.id.slice(0, 8)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-text-dark/60">
                      {req.parentDeleted
                        ? "حساب والد حذف شده است"
                        : req.parentName
                          ? `${req.parentName} — ${req.childLabel}`
                          : req.childLabel}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`h-2.5 w-2.5 rounded-full ${TONE_DOT_CLASSES[mapStatusTone(req.status)]}`}
                      />
                      <Badge variant="default">{req.typeLabel}</Badge>
                      {isKnownOrderStatus(req.status) ? (
                        <OrderStatusBadge status={req.status} />
                      ) : (
                        <Badge variant="default">{req.statusLabel}</Badge>
                      )}
                      <span className="text-xs text-text-dark/40">{formatDate(req.createdAt)}</span>
                      <span className="text-xs text-text-dark/40">{req.candyCost} آبنبات</span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Link href={`/admin/requests/${req.id}`}>
                      <Button variant="secondary" size="sm">مشاهده جزئیات</Button>
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-text-dark/40">
              صفحه {result.pagination.page} از {result.pagination.totalPages} — {result.pagination.total} درخواست
            </p>
            <div className="flex gap-2">
              <Link
                href={buildFilterUrl(base, {
                  type,
                  status: status ? status : null,
                  page: result.pagination.page - 1,
                })}
                aria-disabled={result.pagination.page <= 1}
                className={result.pagination.page <= 1 ? "pointer-events-none opacity-50" : undefined}
              >
                <Button variant="secondary" size="sm" disabled={result.pagination.page <= 1}>
                  قبلی
                </Button>
              </Link>
              <Link
                href={buildFilterUrl(base, {
                  type,
                  status: status ? status : null,
                  page: result.pagination.page + 1,
                })}
                aria-disabled={result.pagination.page >= result.pagination.totalPages}
                className={
                  result.pagination.page >= result.pagination.totalPages
                    ? "pointer-events-none opacity-50"
                    : undefined
                }
              >
                <Button variant="secondary" size="sm" disabled={result.pagination.page >= result.pagination.totalPages}>
                  بعدی
                </Button>
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

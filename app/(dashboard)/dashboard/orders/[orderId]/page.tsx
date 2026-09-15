import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { OrderTimeline } from "@/components/dashboard/orders/order-timeline";
import {
  OrderClosureBlock,
  OrderDetailRows,
  OrderSourceMedia,
} from "@/components/dashboard/orders/order-detail-sections";
import { OrdersErrorState, OrdersNoProfileState } from "@/components/dashboard/orders/orders-states";
import { getParentOrderDetail } from "@/lib/parent/orders/detail-queries";
import { PARENT_STATUS_LABELS, PARENT_STATUS_VARIANTS } from "@/lib/parent/orders/status-mapping";
import { parentTypeIcon, parentTypeLabel } from "@/lib/parent/orders/type-mapping";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * /dashboard/orders/[orderId] — one of the parent's own requests.
 *
 * Read per request so an admin status change is visible on the next load.
 * An order belonging to another parent resolves to the same not-found page as
 * an id that never existed, so this route cannot be used to discover whether
 * someone else's order is real.
 */
export const dynamic = "force-dynamic";

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const supabase = await createServerSupabaseClient();
  const result = await getParentOrderDetail(supabase, orderId);

  if (!result.ok) {
    if (result.reason === "unauthenticated") {
      redirect(`/login?from=/dashboard/orders/${encodeURIComponent(orderId)}`);
    }
    // Another parent's order and a non-existent id are deliberately
    // indistinguishable from here.
    if (result.reason === "not_found") notFound();
  }

  return (
    <div className="mx-auto max-w-[880px]">
      {/* Tall enough to be a comfortable touch target on a phone; the
          negative inset keeps it visually aligned with the heading below. */}
      <Link
        href="/dashboard/orders"
        data-testid="back-to-orders"
        className="-mr-2 mb-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-text-dark/60 hover:text-text-dark sm:min-h-0 sm:mb-4"
      >
        <span aria-hidden="true">→</span> بازگشت به سفارش‌های من
      </Link>

      {!result.ok && result.reason === "no_parent_profile" && <OrdersNoProfileState />}
      {!result.ok && result.reason === "read_failed" && <OrdersErrorState />}

      {result.ok && (
        <>
          <PageHeader title={result.detail.displayTitle} />

          <Card className="mb-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span aria-hidden="true" className="text-base">
                {parentTypeIcon(result.detail.requestType)}
              </span>
              <Badge variant="info" size="sm">
                {parentTypeLabel(result.detail.requestType)}
              </Badge>
              <Badge variant={PARENT_STATUS_VARIANTS[result.detail.status]} size="sm">
                {PARENT_STATUS_LABELS[result.detail.status]}
              </Badge>
            </div>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-text-dark/60">تاریخ ثبت</dt>
                <dd className="text-text-dark">{formatDate(result.detail.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-text-dark/60">هزینه</dt>
                <dd className="text-text-dark">
                  {new Intl.NumberFormat("fa-IR").format(result.detail.candyCost)} آبنبات
                </dd>
              </div>
              {result.detail.completedAt && (
                <div>
                  <dt className="text-text-dark/60">تاریخ تحویل</dt>
                  <dd className="text-text-dark">{formatDate(result.detail.completedAt)}</dd>
                </div>
              )}
            </dl>
          </Card>

          <div className="grid gap-6">
            {result.detail.closure && <OrderClosureBlock closure={result.detail.closure} />}

            <OrderDetailRows
              rows={result.detail.detailRows}
              description={result.detail.description}
            />

            <OrderSourceMedia media={result.detail.sourceMedia} />

            <OrderTimeline events={result.detail.timeline} />
          </div>
        </>
      )}
    </div>
  );
}

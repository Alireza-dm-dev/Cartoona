import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ParentOrderSummary } from "@/lib/parent/orders/types";
import { PARENT_STATUS_LABELS, PARENT_STATUS_VARIANTS } from "@/lib/parent/orders/status-mapping";
import { parentTypeIcon, parentTypeLabel } from "@/lib/parent/orders/type-mapping";

/**
 * Persian-Gregorian date, formatted for display only. The read model carries
 * ISO strings so formatting stays a UI concern.
 */
function formatSubmittedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatCandy(cost: number): string {
  return new Intl.NumberFormat("fa-IR").format(cost);
}

/**
 * One request in the parent list.
 *
 * Cards rather than a table: a parent scans a handful of personal requests and
 * needs the status legible at a glance, which a dense row grid fights on a
 * phone. The layout stacks on small screens and goes side-by-side from `sm`.
 */
export function ParentOrderCard({ order }: { order: ParentOrderSummary }) {
  return (
    <Card variant="admin" className="transition-shadow hover:shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-base">
              {parentTypeIcon(order.requestType)}
            </span>
            <Badge variant="info" size="sm">
              {parentTypeLabel(order.requestType)}
            </Badge>
            <Badge variant={PARENT_STATUS_VARIANTS[order.status]} size="sm">
              {PARENT_STATUS_LABELS[order.status]}
            </Badge>
          </div>

          {/* Parent-authored title. Long titles wrap instead of overflowing. */}
          <h3 className="mb-2 font-semibold break-words text-text-dark">
            {order.displayTitle}
          </h3>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-dark/60">
            <span>ثبت شده در: {formatSubmittedAt(order.createdAt)}</span>
            <span>{formatCandy(order.candyCost)} آبنبات</span>
            {order.completedAt && (
              <span>تحویل شده در: {formatSubmittedAt(order.completedAt)}</span>
            )}
          </div>
        </div>

        <div className="shrink-0">
          <Link href={`/dashboard/orders/${order.id}`} className="block">
            {/* Full width and a 44px minimum height on phones so the primary
                action clears the usual touch-target guidance; it collapses to
                the compact desktop size from `sm` up. */}
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11 w-full sm:min-h-0 sm:w-auto"
            >
              مشاهده جزئیات
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

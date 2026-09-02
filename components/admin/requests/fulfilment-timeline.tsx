import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AdminHistoryItem } from "@/lib/admin/requests/fulfilment-types";
import { mapOrderStatusLabel } from "@/lib/admin/requests/workflow";

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("fa-IR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function statusName(status: string | null): string {
  if (!status) return "ثبت درخواست";
  return mapOrderStatusLabel(status);
}

/**
 * Append-only activity timeline for an order. Rendered server-side; the data
 * comes from get_order_status_history_admin (admin-only internal notes).
 */
export function FulfilmentTimeline({ history }: { history: AdminHistoryItem[] }) {
  if (history.length === 0) {
    return (
      <Card variant="admin">
        <h2 className="mb-3 font-semibold text-parent-navy">تاریخچه وضعیت</h2>
        <p className="text-sm text-text-dark/40">هنوز تغییری در وضعیت درخواست ثبت نشده است.</p>
      </Card>
    );
  }

  return (
    <Card variant="admin">
      <h2 className="mb-4 font-semibold text-parent-navy">تاریخچه وضعیت</h2>
      <ol className="relative flex flex-col gap-4 border-r border-soft-border pr-4">
        {history.map((item, index) => (
          <li key={item.id} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -right-[23px] top-1.5 h-3 w-3 rounded-full border-2 border-white ${
                index === 0 ? "bg-candy-pink" : "bg-soft-border"
              }`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text-dark">
                {statusName(item.previousStatus)}
              </span>
              <span aria-hidden="true" className="text-xs text-text-dark/40">
                ←
              </span>
              <Badge variant="info">{statusName(item.newStatus)}</Badge>
              <span className="text-xs text-text-dark/40">{formatDateTime(item.createdAt)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-dark/50">
              <span>
                توسط:{" "}
                {item.changedByDeleted ? "حساب حذف شده" : item.changedBy ? (
                  <span dir="ltr">{item.changedBy}</span>
                ) : (
                  "حساب حذف شده"
                )}
              </span>
            </div>
            {item.internalNote && (
              <p className="mt-2 rounded-lg border border-soft-border bg-soft-border/20 px-3 py-2 text-sm text-text-dark">
                <span className="font-medium text-text-dark/60">یادداشت داخلی: </span>
                {item.internalNote}
              </p>
            )}
            {item.parentVisibleNote && (
              <p className="mt-1.5 rounded-lg border border-candy-pink/20 bg-candy-pink/5 px-3 py-2 text-sm text-text-dark">
                <span className="font-medium text-text-dark/60">متن قابل مشاهده برای والد: </span>
                {item.parentVisibleNote}
              </p>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

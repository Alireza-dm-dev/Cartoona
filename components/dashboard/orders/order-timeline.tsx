import { Card } from "@/components/ui/card";
import type { ParentTimelineEvent } from "@/lib/parent/orders/detail-types";
import {
  TIMELINE_DESCRIPTIONS,
  TIMELINE_LABELS,
} from "@/lib/parent/orders/timeline-mapping";
import { PARENT_STATUS_VARIANTS } from "@/lib/parent/orders/status-mapping";

const DOT_CLASSES: Record<string, string> = {
  info: "bg-sky-blue",
  warning: "bg-sunshine-yellow",
  success: "bg-mint-green",
  danger: "bg-coral",
  default: "bg-soft-border",
};

function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Parent-facing status timeline.
 *
 * Newest first, matching the order the database returns and the way a parent
 * reads the page: what happened most recently is what they came to find out.
 * The connecting line is drawn on the right because the page is right-to-left.
 *
 * Every string here comes from the mapping module. No internal status or event
 * name is rendered, and the only note shown is `parent_visible_note`, which the
 * database function is the sole source of.
 */
export function OrderTimeline({ events }: { events: ParentTimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <h2 className="mb-2 font-semibold text-parent-navy">روند سفارش</h2>
        <p className="text-sm text-text-dark/60">
          هنوز رویدادی برای این سفارش ثبت نشده است.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="mb-4 font-semibold text-parent-navy">روند سفارش</h2>
      <ol className="relative space-y-5 border-r border-soft-border pr-5">
        {events.map((event, i) => (
          <li key={`${event.at}-${i}`} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -right-[27px] top-1.5 h-3 w-3 rounded-full ring-4 ring-white ${
                DOT_CLASSES[PARENT_STATUS_VARIANTS[event.status]] ?? DOT_CLASSES.default
              }`}
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-medium text-text-dark">{TIMELINE_LABELS[event.status]}</h3>
              <time dateTime={event.at} className="text-xs text-text-dark/50">
                {formatMoment(event.at)}
              </time>
            </div>
            <p className="mt-1 text-sm text-text-dark/70">
              {TIMELINE_DESCRIPTIONS[event.status]}
            </p>
            {event.note && (
              <p className="mt-2 rounded-lg bg-soft-border/20 p-3 text-sm break-words text-text-dark/80">
                {event.note}
              </p>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

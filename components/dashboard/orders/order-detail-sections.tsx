import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type {
  ParentDetailRow,
  ParentOrderClosure,
  ParentSourceMedia,
} from "@/lib/parent/orders/detail-types";
import { CLOSURE_LABELS, closureReasonText } from "@/lib/parent/orders/timeline-mapping";

/** Label/value rows describing the request itself. */
export function OrderDetailRows({
  rows,
  description,
}: {
  rows: ParentDetailRow[];
  description: string | null;
}) {
  if (rows.length === 0 && !description) return null;

  return (
    <Card>
      <h2 className="mb-4 font-semibold text-parent-navy">جزئیات درخواست</h2>
      <dl className="space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-1 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-sm text-text-dark/60 sm:w-32">{row.label}</dt>
            <dd
              className={`text-sm break-words text-text-dark ${
                row.multiline ? "whitespace-pre-line" : ""
              }`}
            >
              {row.value}
            </dd>
          </div>
        ))}
        {description && (
          <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-sm text-text-dark/60 sm:w-32">توضیح شما</dt>
            <dd className="text-sm break-words whitespace-pre-line text-text-dark">
              {description}
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

/**
 * Terminal state block.
 *
 * Unlike the list, this distinguishes rejected from cancelled, which is safe
 * because it comes from the status the database returns to parents. The reason
 * is the admin's parent-visible note when one exists; otherwise a neutral
 * sentence, never the internal note.
 */
export function OrderClosureBlock({ closure }: { closure: ParentOrderClosure }) {
  const isRejected = closure.kind === "rejected";
  return (
    <Card
      className={isRejected ? "border-coral/30 bg-coral/5" : "border-soft-border bg-soft-border/10"}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-parent-navy">وضعیت نهایی</h2>
        <Badge variant={isRejected ? "danger" : "default"} size="sm">
          {CLOSURE_LABELS[closure.kind]}
        </Badge>
      </div>
      <p className="text-sm break-words text-text-dark/80">{closureReasonText(closure)}</p>
      {!closure.reason && (
        <p className="mt-3 text-sm text-text-dark/60">
          برای آگاهی از جزئیات بیشتر،{" "}
          <Link href="/faq" className="font-medium text-candy-pink underline">
            پرسش‌های متداول
          </Link>{" "}
          را ببینید.
        </p>
      )}
    </Card>
  );
}

/**
 * Preview of the files the parent uploaded with this request.
 *
 * Source uploads only. Generated deliverables are excluded at the query, and
 * final-file delivery is a separate phase. Each URL is short-lived and
 * generated per render; the storage path behind it never reaches the browser.
 */
export function OrderSourceMedia({ media }: { media: ParentSourceMedia[] }) {
  if (media.length === 0) return null;

  return (
    <Card>
      <h2 className="mb-2 font-semibold text-parent-navy">فایل‌های ارسالی شما</h2>
      <p className="mb-4 text-sm text-text-dark/60">
        این فایل‌ها را خودتان همراه درخواست فرستاده‌اید و فقط برای شما و تیم بررسی کارتونا قابل مشاهده هستند.
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {media.map((item) => (
          <div
            key={item.id}
            className="overflow-hidden rounded-xl border border-soft-border bg-soft-border/10"
          >
            {item.signedUrl && item.isImage ? (
              /* A plain <img> on purpose: the URL expires in minutes, so it
                 must not pass through the Next image optimiser, which would
                 cache a copy of private media behind a stable public URL. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.signedUrl}
                alt="فایل ارسالی شما"
                className="aspect-square w-full object-cover"
              />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center text-center text-xs text-text-dark/50">
                {item.signedUrl ? "پیش‌نمایش در دسترس نیست" : "پیش‌نمایش موقتاً در دسترس نیست"}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

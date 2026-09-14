import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PARENT_TYPE_ROUTES } from "@/lib/parent/orders/type-mapping";

/**
 * Empty, error and loading presentation for the parent order list.
 *
 * Kept beside the list rather than in `components/ui/` because the copy and
 * the call-to-action routes are specific to this page.
 */

/** No submitted requests yet. Points at the three existing creation routes. */
export function OrdersEmptyState() {
  return (
    <EmptyState
      icon="🎨"
      title="هنوز سفارشی ندارید"
      description="وقتی اولین درخواست خود را ثبت کنید، وضعیت آن را همین‌جا دنبال می‌کنید."
      action={
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
          <Link href={PARENT_TYPE_ROUTES.image}>
            <Button variant="primary" size="md" className="w-full sm:w-auto">
              ساخت تصویر کارتونی
            </Button>
          </Link>
          <Link href={PARENT_TYPE_ROUTES.video}>
            <Button variant="secondary" size="md" className="w-full sm:w-auto">
              درخواست ویدیوی کارتونی
            </Button>
          </Link>
          <Link href={PARENT_TYPE_ROUTES.drawing_animation}>
            <Button variant="secondary" size="md" className="w-full sm:w-auto">
              جان‌بخشی به نقاشی
            </Button>
          </Link>
        </div>
      }
    />
  );
}

/**
 * Read failure. Deliberately says nothing about the underlying cause: the
 * parent can only retry, and the detail would be operational noise at best
 * and a leak at worst.
 */
export function OrdersErrorState() {
  return (
    <Card className="border-coral/30 bg-coral/5 text-center">
      <h3 className="mb-2 font-semibold text-parent-navy">
        فهرست سفارش‌ها بارگذاری نشد
      </h3>
      <p className="mb-4 text-sm text-text-dark/70">
        ارتباط با سرور برقرار نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.
      </p>
      <Link href="/dashboard/orders">
        <Button variant="secondary" size="sm">
          تلاش دوباره
        </Button>
      </Link>
    </Card>
  );
}

/**
 * Parent profile missing. Reached when a signed-in account has not completed
 * consent, so it routes to the existing consent page rather than inventing a
 * recovery flow.
 */
export function OrdersNoProfileState() {
  return (
    <Card className="border-soft-purple/30 bg-soft-purple/5 text-center">
      <h3 className="mb-2 font-semibold text-parent-navy">
        پروفایل والد کامل نیست
      </h3>
      <p className="mb-4 text-sm text-text-dark/70">
        برای دیدن سفارش‌ها ابتدا رضایت والدین را ثبت کنید.
      </p>
      <Link href="/parent-consent">
        <Button variant="primary" size="sm">
          ثبت رضایت والدین
        </Button>
      </Link>
    </Card>
  );
}

/** Skeleton shown by `loading.tsx` while the server component resolves. */
export function OrdersLoadingState() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری سفارش‌ها…</span>
      {[0, 1, 2].map((i) => (
        <Card key={i} variant="admin">
          <div className="animate-pulse">
            <div className="mb-3 flex gap-2">
              <div className="h-5 w-24 rounded-full bg-soft-border/60" />
              <div className="h-5 w-20 rounded-full bg-soft-border/40" />
            </div>
            <div className="mb-3 h-4 w-2/3 rounded bg-soft-border/50" />
            <div className="h-3 w-1/2 rounded bg-soft-border/30" />
          </div>
        </Card>
      ))}
    </div>
  );
}

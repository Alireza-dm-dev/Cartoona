import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import {
  OrdersEmptyState,
  OrdersErrorState,
  OrdersLoadingState,
  OrdersNoProfileState,
} from "@/components/dashboard/orders/orders-states";
import { NewRequestActions } from "@/components/dashboard/new-request-actions";
import { OrdersLoadMore } from "@/components/dashboard/orders/orders-load-more";
import {
  fetchParentOrdersPage,
  verifyParentOrdersCaller,
  type ParentOrdersCaller,
} from "@/lib/parent/orders/backend-orders";

/**
 * /dashboard/orders — the parent's own requests.
 *
 * Read on every request so a status change made by an admin shows on the next
 * load. `middleware.ts` already redirects unauthenticated visitors away from
 * /dashboard; the redirect below is the second line of defence for the case
 * where a session expires between the middleware check and this query.
 *
 * The loading state is an explicit `Suspense` here rather than a segment
 * `loading.tsx`. A `loading.tsx` in this folder would also wrap the nested
 * `[orderId]` route, and the resulting stream flushes a 200 before that page
 * can call `notFound()` — which would turn every missing order into a 200.
 * Keeping the boundary local to this list preserves a real 404 there.
 *
 * V0.1.45: the list is read through the backend (Fastify -> PostgreSQL), the
 * same path as the "load more" API, so every page comes from one database.
 * This page performs no Supabase table or RPC read; Supabase only verifies the
 * session (lib/parent/orders/backend-orders.ts).
 */
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  // The session is verified ONCE, before the boundary, so a signed-out or
  // expired session still produces a real redirect rather than a streamed
  // 200; the list below reuses the verified caller. Middleware has already
  // checked this request too (see docs/ROUTE_CUTOVER.md on the remaining
  // duplicate verification).
  const caller = await verifyParentOrdersCaller();
  if (!caller.ok && caller.reason !== "auth_unavailable") {
    redirect("/login?from=/dashboard/orders");
  }

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="درخواست‌های من"
        description="وضعیت درخواست‌های تصویر، ویدیو و جان‌بخشی به نقاشی را به‌صورت خصوصی دنبال کنید."
      />

      <NewRequestActions />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="mb-2 font-semibold text-parent-navy">سفارش‌ها خصوصی هستند</h3>
        <p className="text-sm text-text-dark/70">
          درخواست‌ها، فایل‌های کودک و خروجی‌های نهایی فقط برای والد و تیم بررسی کارتونا قابل مشاهده هستند و به‌صورت عمومی منتشر نمی‌شوند.
        </p>
      </Card>

      <Suspense fallback={<OrdersLoadingState />}>
        <OrdersList caller={caller} />
      </Suspense>
    </div>
  );
}

/** Streamed separately so the list can show a skeleton while it resolves. */
async function OrdersList({ caller }: { caller: ParentOrdersCaller }) {
  // An auth backend that could not be reached is a retryable error, never a
  // false "logged out".
  if (!caller.ok) return <OrdersErrorState />;

  // First page only: pageSize + 1 rows, never the parent's whole history.
  const result = await fetchParentOrdersPage(caller.context, { cursor: null, limit: null });

  if (!result.ok) {
    // Signed in before a forced invalidation: sign in again.
    if (result.reason === "session_invalidated" || result.reason === "session_expired") {
      redirect("/login?from=/dashboard/orders");
    }
    // A missing profile is a real, explainable state. Admin accounts, which
    // middleware lets into /dashboard but which own no orders, keep seeing it
    // as before (they never had a parent profile).
    if (result.reason === "no_parent_profile" || result.reason === "forbidden") return <OrdersNoProfileState />;
    return <OrdersErrorState />;
  }

  if (result.orders.length === 0 && result.nextCursor === null) return <OrdersEmptyState />;

  return <OrdersLoadMore initialOrders={result.orders} initialCursor={result.nextCursor} />;
}

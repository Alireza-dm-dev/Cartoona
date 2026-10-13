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
import { getParentOrdersPage } from "@/lib/parent/orders/queries";
import {
  resolveParentRequestContext,
  type ParentContextResult,
} from "@/lib/parent/parent-request-context";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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
 */
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  // Identity is resolved ONCE, before the boundary, so an expired session
  // still produces a real redirect rather than a streamed 200, and the list
  // below reuses it instead of asking the auth backend again. "identity" level:
  // middleware has already enforced role and session lifetime on this request.
  const supabase = await createServerSupabaseClient();
  const identity = await resolveParentRequestContext(supabase, { verify: "identity" });
  if (!identity.ok && identity.reason === "unauthenticated") {
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
        <OrdersList supabase={supabase} identity={identity} />
      </Suspense>
    </div>
  );
}

/** Streamed separately so the list can show a skeleton while it resolves. */
async function OrdersList({
  supabase,
  identity,
}: {
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  identity: ParentContextResult;
}) {
  if (!identity.ok) {
    // A missing profile is a real, explainable state; anything else (including
    // an auth backend that could not be reached) is a retryable error, never a
    // false "logged out".
    if (identity.reason === "no_parent_profile") return <OrdersNoProfileState />;
    return <OrdersErrorState />;
  }

  // First page only: pageSize + 1 rows, never the parent's whole history.
  const result = await getParentOrdersPage(supabase, identity.context);

  if (!result.ok) return <OrdersErrorState />;

  if (result.orders.length === 0 && result.nextCursor === null) return <OrdersEmptyState />;

  return <OrdersLoadMore initialOrders={result.orders} initialCursor={result.nextCursor} />;
}

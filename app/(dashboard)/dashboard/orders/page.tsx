import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { ParentOrderCard } from "@/components/dashboard/orders/parent-order-card";
import {
  OrdersEmptyState,
  OrdersErrorState,
  OrdersLoadingState,
  OrdersNoProfileState,
} from "@/components/dashboard/orders/orders-states";
import { getParentOrders } from "@/lib/parent/orders/queries";
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
  // Authentication is resolved before the boundary, so an expired session
  // still produces a real redirect rather than a streamed 200.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?from=/dashboard/orders");

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="سفارش‌های من"
        description="وضعیت درخواست‌های تصویر، ویدیو و جان‌بخشی به نقاشی را به‌صورت خصوصی دنبال کنید."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="mb-2 font-semibold text-parent-navy">سفارش‌ها خصوصی هستند</h3>
        <p className="text-sm text-text-dark/70">
          درخواست‌ها، فایل‌های کودک و خروجی‌های نهایی فقط برای والد و تیم بررسی کارتونا قابل مشاهده هستند و به‌صورت عمومی منتشر نمی‌شوند.
        </p>
      </Card>

      <Suspense fallback={<OrdersLoadingState />}>
        <OrdersList />
      </Suspense>
    </div>
  );
}

/** Streamed separately so the list can show a skeleton while it resolves. */
async function OrdersList() {
  const supabase = await createServerSupabaseClient();
  const result = await getParentOrders(supabase);

  if (!result.ok) {
    if (result.reason === "no_parent_profile") return <OrdersNoProfileState />;
    return <OrdersErrorState />;
  }

  if (result.orders.length === 0) return <OrdersEmptyState />;

  return (
    <div className="grid gap-6">
      {result.orders.map((order) => (
        <ParentOrderCard key={order.id} order={order} />
      ))}
    </div>
  );
}

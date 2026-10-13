"use client";

import { useState } from "react";
import { Button } from "@/components/ui/neu-button";
import { ParentOrderCard } from "@/components/dashboard/orders/parent-order-card";
import { appendUniqueById } from "@/lib/parent/orders/pagination";
import type { ParentOrderSummary } from "@/lib/parent/orders/types";

/**
 * First page arrives server-rendered; "load more" fetches the following pages
 * from the bounded orders API. Rows are appended without duplicates and the
 * button is disabled while a page is in flight. The cursor stays opaque.
 */
export function OrdersLoadMore({
  initialOrders,
  initialCursor,
}: {
  initialOrders: ParentOrderSummary[];
  initialCursor: string | null;
}) {
  const [orders, setOrders] = useState(initialOrders);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/parent/orders?cursor=${encodeURIComponent(cursor)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("orders page failed");
      const body = await res.json();
      const next: ParentOrderSummary[] = Array.isArray(body?.orders) ? body.orders : [];
      setOrders((prev) => appendUniqueById(prev, next));
      setCursor(typeof body?.nextCursor === "string" ? body.nextCursor : null);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="grid gap-6" data-testid="orders-list">
        {orders.map((order) => (
          <ParentOrderCard key={order.id} order={order} />
        ))}
      </div>
      {failed && (
        <p className="mt-4 text-center text-sm text-coral" role="alert">
          بارگذاری سفارش‌های بیشتر ناموفق بود. دوباره تلاش کنید.
        </p>
      )}
      {cursor ? (
        <div className="mt-6 text-center">
          <Button
            variant="secondary"
            onClick={loadMore}
            disabled={loading}
            aria-busy={loading}
            data-testid="orders-load-more"
          >
            {loading ? "در حال بارگذاری…" : "نمایش سفارش‌های بیشتر"}
          </Button>
        </div>
      ) : (
        orders.length > 0 && (
          <p className="mt-6 text-center text-sm text-text-dark/50" data-testid="orders-end">
            همه سفارش‌های شما نمایش داده شد.
          </p>
        )
      )}
    </>
  );
}

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Shown for an order id that does not exist and, deliberately, for one that
 * belongs to another parent. The wording is identical in both cases so the
 * page cannot be used to confirm that someone else's order is real.
 */
export default function OrderNotFound() {
  return (
    <div className="mx-auto max-w-[880px]">
      <EmptyState
        icon="🔍"
        title="این سفارش پیدا نشد"
        description="ممکن است این سفارش حذف شده باشد یا نشانی واردشده درست نباشد."
        action={
          <Link href="/dashboard/orders">
            <Button variant="primary" size="md" className="min-h-11">
              بازگشت به سفارش‌های من
            </Button>
          </Link>
        }
      />
    </div>
  );
}

import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function OrdersPage() {
  return (
    <div>
      <PageHeader
        title="My Orders"
        description="Track all your cartoon requests in one place."
      />
      <EmptyState
        title="No orders yet"
        description="Your request history will appear here once you create your first order."
      />
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Fetch and display real order list from Supabase.
      </p>
    </div>
  );
}

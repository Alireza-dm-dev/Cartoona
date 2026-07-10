import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminRequestsPage() {
  return (
    <div>
      <PageHeader
        title="Request Queue"
        description="Review, fulfill, or reject parent requests."
      />
      <EmptyState
        title="No pending requests"
        description="Parent requests will appear here for admin review and fulfillment."
      />
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Fetch real request queue from Supabase. Add status filters and bulk actions.
      </p>
    </div>
  );
}

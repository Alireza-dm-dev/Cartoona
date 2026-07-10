import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminUsersPage() {
  return (
    <div>
      <PageHeader
        title="User Management"
        description="View and manage parent accounts."
      />
      <EmptyState
        title="No users loaded"
        description="Parent accounts will appear here for admin management."
      />
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Fetch users from Supabase. Add search, suspend, and role management.
      </p>
    </div>
  );
}

import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminCandyLedgerPage() {
  return (
    <div>
      <PageHeader
        title="Candy Ledger"
        description="View all candy transactions across the platform."
      />
      <EmptyState
        title="No transactions"
        description="Candy purchases, grants, and spending will appear here."
      />
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Fetch candy transactions. Add filters by user, date, and type.
      </p>
    </div>
  );
}

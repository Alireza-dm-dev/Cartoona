import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function BillingPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="Billing & Wallet"
        description="Manage your Candy balance and view purchase history."
      />
      <Card>
        <EmptyState
          title="Wallet not yet active"
          description="Your Candy balance, purchase history, and billing information will appear here once payments are enabled."
        />
      </Card>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Integrate Stripe for Candy purchases. Show wallet balance and transaction history.
      </p>
    </div>
  );
}

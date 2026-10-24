import { CandyBillingDashboard } from "@/components/dashboard/billing/candy-billing-dashboard"

// V0.1.51: payments go through the configured provider (POST /api/candy-purchases/[id]/pay);
// the development-only "simulated completion" is gone.
export default function BillingPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <CandyBillingDashboard />
    </div>
  )
}

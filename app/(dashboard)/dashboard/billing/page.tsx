import { CandyBillingDashboard } from "@/components/dashboard/billing/candy-billing-dashboard"

function isSimulationEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false
  return process.env.CARTOONA_ENABLE_DEV_PAYMENT_SIMULATION === "true"
}

export default function BillingPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <CandyBillingDashboard enableDevPaymentSimulation={isSimulationEnabled()} />
    </div>
  )
}

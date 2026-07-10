import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="Transparent Pricing"
        description="Cartoona uses a Candy credit system. Pay only for what you create. No subscriptions required."
      />
      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <h3 className="text-lg font-semibold text-parent-navy">Candies</h3>
          <p className="mt-4 text-3xl font-bold text-candy-pink">Coming Soon</p>
          <p className="mt-2 text-sm text-text-dark/60">
            Purchase candy packs to spend on creations. No recurring fees.
          </p>
        </Card>
        <Card>
          <h3 className="text-lg font-semibold text-parent-navy">Prepaid Packs</h3>
          <p className="mt-4 text-3xl font-bold text-sky-blue">Coming Soon</p>
          <p className="mt-2 text-sm text-text-dark/60">
            Buy candy packs at a discount for frequent creators.
          </p>
        </Card>
        <Card>
          <h3 className="text-lg font-semibold text-parent-navy">Enterprise</h3>
          <p className="mt-4 text-3xl font-bold text-soft-purple">Contact Us</p>
          <p className="mt-2 text-sm text-text-dark/60">
            Schools and organizations — reach out for custom plans.
          </p>
        </Card>
      </div>
      <p className="mt-8 text-center text-sm text-text-dark/50">
        TODO: Final candy pricing, pack sizes, and promotional credit structure to be determined.
      </p>
    </div>
  );
}

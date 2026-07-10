import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader title={`Order ${orderId}`} description="Private request tracking and details." />
      <Card>
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 text-4xl" aria-hidden="true">📋</div>
          <h3 className="font-semibold text-text-dark">Request Details</h3>
          <p className="mt-2 text-sm text-text-dark/60">
            Order status, preview, and download links will appear here once fulfilled.
          </p>
          <p className="mt-4 text-xs text-text-dark/30">
            TODO: Fetch real order data for {orderId}. Add status timeline and preview.
          </p>
        </div>
      </Card>
    </div>
  );
}

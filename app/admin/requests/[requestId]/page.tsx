import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

export default async function AdminRequestDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;

  return (
    <div className="mx-auto max-w-[960px]">
      <PageHeader title={`Request ${requestId}`} description="Review and fulfill this request." />
      <Card variant="admin">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 text-4xl" aria-hidden="true">🔍</div>
          <h3 className="font-semibold text-text-dark">Admin Review Panel</h3>
          <p className="mt-2 text-sm text-text-dark/60">
            Request details, parent info, uploaded assets, and fulfillment controls will appear here.
          </p>
          <p className="mt-4 text-xs text-text-dark/30">
            TODO: Build admin fulfillment UI for {requestId}. Add approve/reject/upload controls.
          </p>
        </div>
      </Card>
    </div>
  );
}

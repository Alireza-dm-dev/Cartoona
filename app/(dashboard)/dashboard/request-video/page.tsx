import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function RequestVideoPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="Request Video"
        description="Submit a video request featuring Cartoona characters."
      />
      <Card>
        <EmptyState
          title="Video request flow"
          description="Character, storyline, and style selection will go here. Videos are fulfilled manually and reviewed for safety."
        />
      </Card>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Build video request wizard with manual admin fulfillment.
      </p>
    </div>
  );
}

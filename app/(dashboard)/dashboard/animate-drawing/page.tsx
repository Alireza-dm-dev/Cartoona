import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function AnimateDrawingPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="Animate a Drawing"
        description="Upload your child's drawing and we'll bring it to life."
      />
      <Card>
        <EmptyState
          title="Drawing upload flow"
          description="Upload scan/photo of a drawing, choose animation style, and submit. Requires parent consent."
        />
      </Card>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Build drawing upload and animation request flow.
      </p>
    </div>
  );
}

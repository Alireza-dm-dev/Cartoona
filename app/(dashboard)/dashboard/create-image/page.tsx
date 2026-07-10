import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function CreateImagePage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="Create Image"
        description="Choose a character, theme, and describe the scene you want."
      />
      <Card>
        <EmptyState
          title="Image creation wizard"
          description="Character selection, theme picker, and prompt builder will go here. All images are reviewed before delivery."
        />
      </Card>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Build controlled image generation wizard.
      </p>
    </div>
  );
}

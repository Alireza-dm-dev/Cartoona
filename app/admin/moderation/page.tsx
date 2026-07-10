import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminModerationPage() {
  return (
    <div>
      <PageHeader
        title="Moderation Queue"
        description="Review flagged content and safety reports."
      />
      <EmptyState
        title="Queue is clear"
        description="Flagged content, moderation reviews, and safety reports will appear here."
      />
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Build moderation workflow. Connect to moderation rules and safety queue.
      </p>
    </div>
  );
}

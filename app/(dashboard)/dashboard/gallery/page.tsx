import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { SafetyNotice } from "@/components/ui/safety-notice";

export default function GalleryPage() {
  return (
    <div>
      <PageHeader
        title="Family Gallery"
        description="Your private collection of cartoon creations — visible only to your family."
      />
      <EmptyState
        title="Your gallery is empty"
        description="Completed images and videos will appear here. This gallery is private to your account."
      />
      <div className="mt-6">
        <SafetyNotice>
          This gallery is private by default. No public sharing, no social features.
          You control who sees your family&apos;s creations.
        </SafetyNotice>
      </div>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Fetch real media from Supabase storage. Private per-parent.
      </p>
    </div>
  );
}

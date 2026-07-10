import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminMediaPage() {
  return (
    <div>
      <PageHeader
        title="Media Review"
        description="Review uploaded and generated media assets."
      />
      <EmptyState
        title="No media assets"
        description="Generated and uploaded media will appear here for review."
      />
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Fetch media from Supabase storage. Add preview, approve, and flag controls.
      </p>
    </div>
  );
}

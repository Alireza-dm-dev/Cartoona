import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function ChildrenPage() {
  return (
    <div>
      <PageHeader
        title="Children"
        description="Optionally create private profiles for your children to personalize their experience."
      />
      <Card>
        <EmptyState
          title="No child profiles yet"
          description="Add optional profiles to help us personalize character and theme suggestions. These are private to your account."
        />
      </Card>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Add child profile CRUD. Profiles are optional and parent-owned.
      </p>
    </div>
  );
}

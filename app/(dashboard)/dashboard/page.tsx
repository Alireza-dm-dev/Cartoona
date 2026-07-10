import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CandyBalanceBadge } from "@/components/ui/candy-balance-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import Link from "next/link";

export default function ParentDashboardPage() {
  return (
    <div>
      <PageHeader
        title="Parent Dashboard"
        description="Manage your requests, gallery, and account."
        action={<CandyBalanceBadge balance={0} />}
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Link href="/dashboard/create-image">
          <Card className="h-full transition-shadow hover:shadow-md">
            <div className="mb-2 text-2xl" aria-hidden="true">🖼️</div>
            <h3 className="font-semibold text-text-dark">Create Image</h3>
            <p className="mt-1 text-xs text-text-dark/60">Request a cartoon image</p>
          </Card>
        </Link>
        <Link href="/dashboard/request-video">
          <Card className="h-full transition-shadow hover:shadow-md">
            <div className="mb-2 text-2xl" aria-hidden="true">🎬</div>
            <h3 className="font-semibold text-text-dark">Request Video</h3>
            <p className="mt-1 text-xs text-text-dark/60">Request a cartoon video</p>
          </Card>
        </Link>
        <Link href="/dashboard/animate-drawing">
          <Card className="h-full transition-shadow hover:shadow-md">
            <div className="mb-2 text-2xl" aria-hidden="true">✏️</div>
            <h3 className="font-semibold text-text-dark">Animate Drawing</h3>
            <p className="mt-1 text-xs text-text-dark/60">Upload and animate a drawing</p>
          </Card>
        </Link>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-text-dark">Active Requests</h2>
        <EmptyState
          title="No active requests"
          description="Your request history and status updates will appear here."
          action={
            <Link href="/dashboard/create-image">
              <Button variant="secondary" size="sm">Create your first request</Button>
            </Link>
          }
        />
      </section>

      {/* TODO: Add real data fetching + auth guard */}
      <p className="mt-8 text-xs text-text-dark/30 text-center">
        TODO: Connect to Supabase for real data. Add auth guard — parents only.
      </p>
    </div>
  );
}

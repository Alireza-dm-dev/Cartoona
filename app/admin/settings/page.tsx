import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

export default function AdminSettingsPage() {
  return (
    <div className="mx-auto max-w-[960px]">
      <PageHeader
        title="Platform Settings"
        description="Configure platform-wide settings."
      />
      <Card variant="admin" className="mb-4">
        <h3 className="font-semibold text-text-dark">General</h3>
        <p className="mt-1 text-sm text-text-dark/50">Platform name, maintenance mode, default language.</p>
      </Card>
      <Card variant="admin" className="mb-4">
        <h3 className="font-semibold text-text-dark">Moderation</h3>
        <p className="mt-1 text-sm text-text-dark/50">Moderation rules, thresholds, and auto-flag settings.</p>
      </Card>
      <Card variant="admin" className="mb-4">
        <h3 className="font-semibold text-text-dark">Pricing</h3>
        <p className="mt-1 text-sm text-text-dark/50">Candy costs, pack sizes, and promotional credit settings.</p>
      </Card>
      <Card variant="admin">
        <h3 className="font-semibold text-text-dark">AI Providers</h3>
        <p className="mt-1 text-sm text-text-dark/50">Image and video generation provider configuration.</p>
      </Card>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        TODO: Build settings forms. Admin role guard needed.
      </p>
    </div>
  );
}

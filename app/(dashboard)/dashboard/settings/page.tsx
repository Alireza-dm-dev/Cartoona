import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { SafetyNotice } from "@/components/ui/safety-notice";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="Account Settings"
        description="Manage your profile, privacy, and account deletion."
      />
      <Card className="mb-4">
        <h3 className="font-semibold text-text-dark">Profile</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          Name, email, and parent verification settings.
        </p>
        {/* TODO: Profile edit form */}
      </Card>
      <Card className="mb-4">
        <h3 className="font-semibold text-text-dark">Privacy</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          Consent management, data export, and visibility controls.
        </p>
        {/* TODO: Privacy controls */}
      </Card>
      <Card>
        <h3 className="font-semibold text-coral">Delete Account</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
        {/* TODO: Account deletion flow with confirmation */}
      </Card>
      <div className="mt-6">
        <SafetyNotice title="Data & Privacy">
          You can request a full data export or account deletion at any time.
          All child-associated data is removed upon parent account deletion.
        </SafetyNotice>
      </div>
    </div>
  );
}

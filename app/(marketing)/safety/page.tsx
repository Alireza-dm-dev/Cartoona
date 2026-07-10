import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { SafetyNotice } from "@/components/ui/safety-notice";

const principles = [
  { title: "Parent-Only Accounts", description: "Only parents can create and manage accounts. Children never have independent access." },
  { title: "Private by Default", description: "Every creation is private to your family. No public galleries, no social feeds, no sharing without your explicit consent." },
  { title: "Manual Moderation", description: "All content is reviewed before delivery. Nothing reaches your family without a safety check." },
  { title: "You Control Your Data", description: "Download your content anytime. Delete your account and all associated data with a single request." },
  { title: "No Child Data Selling", description: "We never sell or share child data. Period." },
  { title: "Consent First", description: "Uploads require explicit parent consent. We maintain clear consent records." },
];

export default function SafetyPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="Safety & Privacy"
        description="Cartoona is built from the ground up with parent-first safety and privacy principles."
      />
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {principles.map((principle) => (
          <Card key={principle.title} variant="admin">
            <h3 className="font-semibold text-parent-navy">{principle.title}</h3>
            <p className="mt-2 text-sm text-text-dark/60">{principle.description}</p>
          </Card>
        ))}
      </div>
      <div className="mt-8">
        <SafetyNotice title="Our Commitment">
          Your family&apos;s privacy is not an afterthought — it is the foundation of this platform.
          If we cannot guarantee safety, we do not ship the feature.
        </SafetyNotice>
      </div>
    </div>
  );
}

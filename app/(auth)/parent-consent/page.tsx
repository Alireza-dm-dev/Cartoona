import { Card } from "@/components/ui/card";

export default function ParentConsentPage() {
  return (
    <Card>
      <h1 className="text-2xl font-bold text-parent-navy">Parental Consent</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        Cartoona requires explicit parental consent for account creation and content uploads.
      </p>

      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-soft-border bg-cream/50 p-4 text-sm text-text-dark/70">
          <h2 className="font-semibold text-parent-navy">What consent means</h2>
          <ul className="mt-2 list-inside list-disc space-y-1">
            <li>You confirm you are a parent or legal guardian.</li>
            <li>You authorize the creation and storage of content featuring or referencing your child.</li>
            <li>You understand that all content is private and reviewed for safety.</li>
            <li>You may revoke consent and request deletion at any time.</li>
          </ul>
        </div>

        <div className="rounded-xl border border-soft-border bg-cream/50 p-4 text-center text-sm text-text-dark/50">
          {/* TODO: Replace with real consent flow — checkbox, e-signature, or email verification */}
          Consent form not yet implemented.
        </div>
      </div>
    </Card>
  );
}

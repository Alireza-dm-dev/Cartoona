import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  return (
    <Card>
      <h1 className="text-2xl font-bold text-parent-navy">Log in</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        Sign in to your parent account. Admin users will be redirected to the admin console.
      </p>

      {/* TODO: Replace with real auth form */}
      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-soft-border bg-cream/50 p-4 text-center text-sm text-text-dark/50">
          Auth form placeholder — login with email/password or social providers.
        </div>

        <div className="flex flex-col gap-2">
          <Button disabled>Sign in (coming soon)</Button>
          <Button variant="secondary" disabled>
            Continue with Google (coming soon)
          </Button>
        </div>

        <p className="text-center text-xs text-text-dark/40">
          {/* TODO: Add real auth role routing */}
          Parent and admin authentication not yet implemented.
        </p>
      </div>
    </Card>
  );
}

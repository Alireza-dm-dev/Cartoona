import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function SignupPage() {
  return (
    <Card>
      <h1 className="text-2xl font-bold text-parent-navy">Create your parent account</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        Only parents or legal guardians may create accounts. Child accounts are not supported.
      </p>

      {/* TODO: Replace with real signup form */}
      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-soft-border bg-cream/50 p-4 text-center text-sm text-text-dark/50">
          Signup form placeholder — name, email, password, parent verification.
        </div>

        <div className="flex flex-col gap-2">
          <Button disabled>Create account (coming soon)</Button>
        </div>

        <p className="text-center text-xs text-text-dark/40">
          {/* TODO: Add real auth signup + parent verification */}
          Parent signup not yet implemented.
        </p>
      </div>
    </Card>
  );
}

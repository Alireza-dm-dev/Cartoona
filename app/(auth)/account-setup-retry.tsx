"use client";

import { useState } from "react";
import { Button } from "@/components/ui/neu-button";
import { ensureParentAccountSetup } from "@/lib/parent/account-setup/account-setup-client";

/**
 * "Signed in, but the account is not ready yet" (V0.1.49), shared by /login,
 * /signup and /parent-consent. The parent stays signed in; the button repeats
 * the idempotent bootstrap (POST /api/parent/account-setup) and continues
 * only when it answers ready. Nothing is retried automatically, and nothing
 * continues into the parent pages before the account exists.
 */
export default function AccountSetupRetry({
  message,
  onReady,
}: {
  message: string;
  /** Default: reload the current page (a server page re-reads with the account in place). */
  onReady?: () => void | Promise<void>;
}) {
  const [text, setText] = useState(message);
  const [loading, setLoading] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const retry = async () => {
    setLoading(true);
    try {
      const setup = await ensureParentAccountSetup();
      if (setup.status === "ready") {
        if (onReady) await onReady();
        else window.location.reload();
        return;
      }
      if (setup.status === "signed_out") {
        window.location.assign("/login");
        return;
      }
      setText(setup.message);
      setBlocked(setup.status === "blocked");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-6 space-y-4" data-testid="account-setup-retry">
      <p role="alert" className="text-sm text-coral">
        {text}
      </p>
      {!blocked && (
        <Button type="button" className="w-full" disabled={loading} onClick={retry}>
          {loading ? "در حال آماده‌سازی..." : "تلاش دوباره"}
        </Button>
      )}
    </div>
  );
}

import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { loadParentConsent } from "@/lib/parent/consent/backend-consent";
import { gateParentPage } from "@/lib/auth/page-gates";
import ParentConsentForm from "./parent-consent-form";
import AccountSetupRetry from "../account-setup-retry";
import { ACCOUNT_SETUP_INCOMPLETE } from "@/lib/parent/account-setup/messages";

/**
 * /parent-consent (V0.1.48): consent is read from PostgreSQL (session verified
 * by the provider -> v2 assertion -> Fastify -> PostgreSQL), never from
 * Supabase. The Edge middleware only checks that a session exists (V0.1.53);
 * the role / 30-day gate is gateParentPage() above.
 *
 *   granted       the form component continues at once, to the same place a
 *                 successful submit goes (a pending draft -> /complete-request,
 *                 else /dashboard). The draft lives in the browser, so that
 *                 choice is made client-side.
 *   not granted   the form, unchanged.
 *   no profile / identity not linked (V0.1.49): the account is not ready in
 *                 PostgreSQL yet (signed up after the data copy, or the
 *                 bootstrap failed). A retry card that runs the idempotent
 *                 bootstrap (POST, never on this GET) and reloads.
 *   could not determine (backend/database/provider down): a retry message.
 *                 Never the form-as-if-not-consented, never a redirect, so an
 *                 outage cannot bounce a consented parent between pages.
 *   signed out / expired / invalidated -> /login (with from=/parent-consent).
 */
export const dynamic = "force-dynamic";

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <div role="alert" className="text-center">
        <h1 className="mb-2 text-lg font-semibold text-parent-navy">{title}</h1>
        <p className="text-sm text-text-dark/70">{children}</p>
      </div>
    </Card>
  );
}

function SetupIncomplete() {
  return (
    <Card>
      <h1 className="text-lg font-semibold text-parent-navy text-center">آماده‌سازی حساب</h1>
      <AccountSetupRetry message={ACCOUNT_SETUP_INCOMPLETE} />
    </Card>
  );
}

export default async function ParentConsentPage() {
  // V0.1.53: the Edge middleware no longer reads a role. Admins go to /admin and
  // an expired session to /login from PostgreSQL's role; an unlinked identity
  // stays here (this page runs the account bootstrap).
  const gate = await gateParentPage("/parent-consent", { adminTo: "/admin", allowUnlinked: true });
  if (!gate.ok) {
    return (
      <Notice title="بررسی نشست">
        بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.
      </Notice>
    );
  }
  const consent = await loadParentConsent();

  if (consent.ok) {
    if (consent.status === "no_profile") return <SetupIncomplete />;
    return <ParentConsentForm initiallyGranted={consent.status === "granted"} />;
  }

  switch (consent.reason) {
    case "unauthenticated":
      redirect("/login?from=/parent-consent");
    case "session_expired":
    case "session_invalidated":
      redirect("/login?reason=session_expired&from=/parent-consent");
    case "identity_not_linked":
      return <SetupIncomplete />;
    case "forbidden":
      return <Notice title="دسترسی ممکن نیست">شما مجوز انجام این عملیات را ندارید.</Notice>;
    case "auth_unavailable":
    case "service_unavailable":
      return (
        <Notice title="بررسی رضایت موقتاً ممکن نیست">
          لطفاً چند لحظه بعد{" "}
          <a href="/parent-consent" className="font-semibold text-candy-pink">
            دوباره تلاش کنید
          </a>
          .
        </Notice>
      );
  }
}

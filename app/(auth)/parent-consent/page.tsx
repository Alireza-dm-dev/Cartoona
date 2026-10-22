import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { loadParentConsent } from "@/lib/parent/consent/backend-consent";
import ParentConsentForm from "./parent-consent-form";

/**
 * /parent-consent (V0.1.48): consent is read from PostgreSQL (session verified
 * by the provider -> v2 assertion -> Fastify -> PostgreSQL), never from
 * Supabase. Middleware still runs first (signed in, role, admins -> /admin,
 * 30-day lifetime).
 *
 *   granted       the form component continues at once, to the same place a
 *                 successful submit goes (a pending draft -> /complete-request,
 *                 else /dashboard). The draft lives in the browser, so that
 *                 choice is made client-side.
 *   not granted   the form, unchanged.
 *   no profile    a dead-end form would only fail: say so instead.
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

export default async function ParentConsentPage() {
  const consent = await loadParentConsent();

  if (consent.ok) {
    if (consent.status === "no_profile") {
      return (
        <Notice title="پروفایل والد کامل نیست">
          پروفایل والد برای این حساب یافت نشد. لطفاً با پشتیبانی تماس بگیرید.
        </Notice>
      );
    }
    return <ParentConsentForm initiallyGranted={consent.status === "granted"} />;
  }

  switch (consent.reason) {
    case "unauthenticated":
      redirect("/login?from=/parent-consent");
    case "session_expired":
    case "session_invalidated":
      redirect("/login?reason=session_expired&from=/parent-consent");
    case "identity_not_linked":
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

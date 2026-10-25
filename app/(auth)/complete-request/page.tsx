import { redirect } from "next/navigation";
import { gateParentPage } from "@/lib/auth/page-gates";
import { loadParentConsent } from "@/lib/parent/consent/backend-consent";
import { PageHeader } from "@/components/ui/page-header";
import CompleteCreationRequest from "@/components/creation/complete-creation-request";

// Per-request, auth-gated page: it reads the session on every request and must
// never be prerendered. Without this, `next build` would try to render it and
// fail on the missing Supabase configuration, making the build depend on a
// live backend (V0.1.35).
export const dynamic = "force-dynamic";

export default async function CompleteRequestPage() {
  // Role + session lifetime from PostgreSQL through the backend (V0.1.53; was a
  // Supabase `users.role` read plus a local lifetime check). An admin is sent
  // to /admin, an expired session to /login, an unlinked identity to the
  // consent page (which runs the account bootstrap).
  const gate = await gateParentPage("/complete-request", { adminTo: "/admin" });
  if (!gate.ok) {
    return (
      <div role="alert" className="mx-auto max-w-[560px] py-12 text-center">
        <p className="mb-4 text-text-dark/80">
          بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.
        </p>
        <a href="/complete-request" className="font-semibold text-candy-pink">
          تلاش دوباره
        </a>
      </div>
    );
  }

  // Consent gate (V0.1.48): PostgreSQL through the backend, the same source
  // the consent write uses. It was a Supabase read here and in middleware;
  // middleware (Edge runtime) no longer checks consent at all.
  //   not granted / no profile  -> /parent-consent (as before)
  //   could not determine        -> retry message. Before V0.1.48 a failed
  //     read redirected to /parent-consent, which for a consented parent is
  //     a misleading detour (and with a page that forwards consented parents
  //     back here, a potential loop). Never treated as "not consented".
  const consent = await loadParentConsent();
  if (consent.ok) {
    if (consent.status !== "granted") redirect("/parent-consent");
  } else {
    switch (consent.reason) {
      case "unauthenticated":
        redirect("/login?from=/complete-request");
      case "session_expired":
      case "session_invalidated":
        redirect("/login?reason=session_expired&from=/complete-request");
      case "identity_not_linked":
      case "forbidden":
        return (
          <div role="alert" className="mx-auto max-w-[560px] py-12 text-center">
            <p className="text-text-dark/80">شما مجوز انجام این عملیات را ندارید.</p>
          </div>
        );
      case "auth_unavailable":
      case "service_unavailable":
        return (
          <div role="alert" className="mx-auto max-w-[560px] py-12 text-center">
            <p className="mb-4 text-text-dark/80">
              بررسی رضایت والدین موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.
            </p>
            <a href="/complete-request" className="font-semibold text-candy-pink">
              تلاش دوباره
            </a>
          </div>
        );
    }
  }

  return (
    <div>
      <PageHeader
        title="بررسی نهایی درخواست"
        description="جزئیات درخواست را پیش از ثبت نهایی مرور کنید."
      />
      <CompleteCreationRequest />
    </div>
  );
}

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAdminRole } from "@/lib/auth/admin-role";
import { isParentRole } from "@/lib/auth/parent-access";
import { checkParentSessionLifetime } from "@/lib/auth/parent-session-lifetime";
import { loadParentConsent } from "@/lib/parent/consent/backend-consent";
import { PageHeader } from "@/components/ui/page-header";
import CompleteCreationRequest from "@/components/creation/complete-creation-request";

// Per-request, auth-gated page: it reads the session on every request and must
// never be prerendered. Without this, `next build` would try to render it and
// fail on the missing Supabase configuration, making the build depend on a
// live backend (V0.1.35).
export const dynamic = "force-dynamic";

export default async function CompleteRequestPage() {
  const supabase = await createServerSupabaseClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    redirect("/login?from=/complete-request");
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (roleError || !roleRow) {
    redirect("/login?from=/complete-request");
  }

  if (isAdminRole(roleRow.role)) {
    redirect("/admin");
  }

  if (!isParentRole(roleRow.role)) {
    redirect("/login?from=/complete-request");
  }

  const lifetime = await checkParentSessionLifetime(supabase, user.id);
  if (!lifetime.valid) {
    // A failed lookup is not an expiry: do not send a valid session to the
    // login page labelled "expired". Fail closed with a retry message.
    if (lifetime.reason === "lookup_failed") {
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
    redirect("/login?reason=session_expired&from=/complete-request");
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

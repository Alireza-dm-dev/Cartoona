import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAdminRole } from "@/lib/auth/admin-role";
import { isParentRole } from "@/lib/auth/parent-access";
import { checkParentSessionLifetime } from "@/lib/auth/parent-session-lifetime";
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

  const { data: profileRow, error: profileError } = await supabase
    .from("parent_profiles")
    .select("consent_granted")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    redirect("/parent-consent");
  }

  if (!profileRow || !profileRow.consent_granted) {
    redirect("/parent-consent");
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

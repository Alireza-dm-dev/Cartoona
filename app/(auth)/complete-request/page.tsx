import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAdminRole } from "@/lib/auth/admin-role";
import { isParentRole } from "@/lib/auth/parent-access";
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime";
import { PageHeader } from "@/components/ui/page-header";
import CompleteCreationRequest from "@/components/creation/complete-creation-request";

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

  const lifetime = await checkCurrentParentSessionLifetime(supabase);
  if (!lifetime.valid) {
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

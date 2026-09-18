import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { SafetyNotice } from "@/components/ui/safety-notice";
import { ParentPasswordForm } from "@/components/settings/parent-password-form";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Whether this parent has already chosen a password.
 *
 * `password_set` is written by /api/parent/password. `password_enabled` is the
 * older flag from the days when signup required a password, and is read so
 * those accounts are described correctly too. Neither is a permission check —
 * they only decide whether the card says "set" or "change".
 */
async function hasPasswordSet(): Promise<boolean> {
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    const metadata = user?.user_metadata ?? {};
    return metadata.password_set === true || metadata.password_enabled === true;
  } catch {
    // The page still renders; the parent is simply offered the neutral
    // "set a password" wording.
    return false;
  }
}

export default async function SettingsPage() {
  const passwordSet = await hasPasswordSet();

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="تنظیمات حساب"
        description="مدیریت پروفایل، رمز عبور، حریم خصوصی و حذف حساب."
      />

      {/* Anchor target for the "پروفایل" navigation entry. Profile and settings
          are one page: the nav deep-links here rather than introducing a second
          profile system. */}
      <section id="profile" className="scroll-mt-24">
        <Card className="mb-4">
          <h3 className="font-semibold text-text-dark">پروفایل</h3>
          <p className="mt-1 text-sm text-text-dark/50">
            نام و اطلاعات حساب والدین.
          </p>
          {/* TODO: Profile edit form */}
        </Card>
      </section>

      <Card className="mb-4">
        <h3 className="font-semibold text-text-dark">
          {passwordSet ? "تغییر رمز عبور" : "تنظیم رمز عبور"}
        </h3>
        <p className="mt-1 text-sm text-text-dark/50">
          {passwordSet
            ? "می‌توانید رمز عبور فعلی حساب خود را تغییر دهید."
            : "رمز عبور اختیاری است. با تنظیم آن می‌توانید علاوه بر کد ورود، با شماره موبایل و رمز عبور هم وارد شوید."}
        </p>
        <p className="mt-1 text-xs text-text-dark/40">
          ورود با کد همیشه برای حساب شما فعال می‌ماند، چه رمز عبور تنظیم کنید چه نکنید.
        </p>
        <div className="mt-4">
          <ParentPasswordForm passwordSet={passwordSet} />
        </div>
      </Card>

      <Card className="mb-4">
        <h3 className="font-semibold text-text-dark">حریم خصوصی</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          مدیریت رضایت والدین، خروجی داده و کنترل‌های مشاهده‌پذیری.
        </p>
        {/* TODO: Privacy controls */}
      </Card>

      <Card>
        <h3 className="font-semibold text-coral">حذف حساب</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          حذف دائمی حساب و تمام داده‌های مرتبط. این عملیات قابل بازگشت نیست.
        </p>
        {/* TODO: Account deletion flow with confirmation */}
      </Card>

      <div className="mt-6">
        <SafetyNotice title="داده‌ها و حریم خصوصی">
          شما می‌توانید در هر زمان درخواست خروجی کامل داده‌ها یا حذف حساب خود را ثبت کنید.
          تمام داده‌های مرتبط با کودک پس از حذف حساب والدین پاک می‌شوند.
        </SafetyNotice>
      </div>
    </div>
  );
}

import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { SafetyNotice } from "@/components/ui/safety-notice";
import { ParentPasswordForm } from "@/components/settings/parent-password-form";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="تنظیمات حساب"
        description="مدیریت پروفایل، رمز عبور، حریم خصوصی و حذف حساب."
      />

      <Card className="mb-4">
        <h3 className="font-semibold text-text-dark">پروفایل</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          نام و اطلاعات حساب والدین.
        </p>
        {/* TODO: Profile edit form */}
      </Card>

      <Card className="mb-4">
        <h3 className="font-semibold text-text-dark">رمز عبور</h3>
        <p className="mt-1 text-sm text-text-dark/50">
          با تنظیم رمز عبور می‌توانید علاوه بر کد پیامکی، با شماره موبایل و رمز عبور وارد شوید.
        </p>
        <p className="mt-1 text-xs text-text-dark/40">
          ورود با کد پیامکی همیشه برای حساب شما فعال می‌ماند.
        </p>
        <div className="mt-4">
          <ParentPasswordForm />
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

import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const sections = [
  {
    title: "تنظیمات عمومی",
    description:
      "نام پلتفرم، وضعیت نمایش عمومی و پیام‌های پایه محصول در این بخش مدیریت خواهند شد.",
  },
  {
    title: "تنظیمات بررسی ایمنی",
    description:
      "قوانین بررسی دستی، حریم خصوصی کودک و محدودیت‌های محتوایی در این بخش تنظیم خواهند شد.",
  },
  {
    title: "تنظیمات آبنبات و قیمت‌گذاری",
    description:
      "هزینه آبنباتی درخواست‌ها، بسته‌های اعتباری و تنظیمات مالی آینده در این بخش قرار می‌گیرند.",
  },
  {
    title: "ارائه‌دهندگان هوش مصنوعی",
    description:
      "اتصال مدل‌های تصویر، ویدیو و جان‌بخشی در مراحل بعدی از این بخش مدیریت می‌شود.",
  },
];

export default function AdminSettingsPage() {
  return (
    <div className="mx-auto max-w-[960px]">
      <PageHeader
        title="تنظیمات پلتفرم"
        description="نمایش تنظیمات اصلی کارتونا برای کنترل ایمنی، قیمت‌گذاری، نقش‌ها و آماده‌سازی اتصال‌های آینده."
      />
      <Card variant="admin" className="mb-8 border-sky-blue/20 bg-sky-blue/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">⚙️</span>
          <div>
            <h3 className="font-semibold text-parent-navy">یادآوری نقش ادمین</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              تغییر تنظیمات اصلی پلتفرم فقط پس از تکمیل نقش ادمین، احراز هویت و
              سیاست‌های امنیتی فعال خواهد شد. این صفحه در حال حاضر نمایشی است.
            </p>
          </div>
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        {sections.map((section) => (
          <Card key={section.title} variant="admin">
            <h3 className="font-semibold text-text-dark">{section.title}</h3>
            <p className="mt-1 text-sm text-text-dark/50">{section.description}</p>
          </Card>
        ))}
      </div>
      <div className="mt-8">
        <Button variant="primary" disabled>
          ذخیره تنظیمات
        </Button>
      </div>
      <p className="mt-4 text-xs text-text-dark/30 text-center">
        فرم‌های تنظیمات پس از تکمیل احراز هویت، نقش ادمین و ذخیره‌سازی امن فعال خواهند شد.
      </p>
    </div>
  );
}

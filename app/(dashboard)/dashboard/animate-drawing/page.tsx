import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { characters } from "@/config/characters";

const categoryLabels: Record<string, string> = {
  Adventure: "ماجراجویی",
  Fantasy: "فانتازی",
  Animals: "حیوانات",
  "Sci-Fi": "علمی-تخیلی",
  Education: "آموزشی",
};

export default function AnimateDrawingPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="جان‌بخشی به نقاشی"
        description="نقاشی کودک را برای تبدیل به یک خروجی کارتونی متحرک و خصوصی آماده کنید. در MVP، درخواست‌ها به‌صورت دستی بررسی و آماده می‌شوند."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-2">نقاشی کودک خصوصی می‌ماند</h3>
        <p className="text-sm text-text-dark/70">
          نقاشی و فایل‌های مرتبط فقط برای والد و تیم بررسی کارتونا قابل مشاهده هستند و به‌صورت عمومی منتشر نمی‌شوند.
        </p>
      </Card>

      <Card className="mb-6">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">عنوان درخواست</label>
              <input
                type="text"
                placeholder="مثلا: سفر پرهای مهتابی"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">سبک حرکت</label>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-soft-border bg-soft-border/5 p-3 text-center text-xs text-text-dark/60">
                  حرکت آرام و لطیف
                </div>
                <div className="rounded-lg border border-soft-border bg-soft-border/5 p-3 text-center text-xs text-text-dark/60">
                  حرکت شاد و بازیگوش
                </div>
                <div className="rounded-lg border border-soft-border bg-soft-border/5 p-3 text-center text-xs text-text-dark/60">
                  تبدیل به صحنه کارتونی
                </div>
                <div className="rounded-lg border border-soft-border bg-soft-border/5 p-3 text-center text-xs text-text-dark/60">
                  حرکت کوتاه برای ویدیو
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">توضیح کوتاه درباره نقاشی</label>
            <textarea
              placeholder="متن خود را اینجا بنویسید"
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30 min-h-[80px]"
              disabled
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">حس و حال خروجی</label>
              <input
                type="text"
                placeholder="مثلا: احساسات شادانه"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">مدت تقریبی</label>
              <input
                type="text"
                placeholder="مثلا: 30 ثانیه"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">یادداشت والد</label>
            <textarea
              placeholder="مثلا: کودک دوست دارد پرنده‌های رنگارنگ ببیند..."
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30 min-h-[60px]"
              disabled
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">فایل نقاشی کودک</label>
            <div className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/50">
              بارگذاری فایل در مراحل بعدی فعال می‌شود.
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">فایل مرجع / تصویر کمکی</label>
            <div className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/50">
              بارگذاری فایل در مراحل بعدی فعال می‌شود.
            </div>
          </div>
        </div>
      </Card>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-2">یادآوری رضایت والد</h3>
        <p className="text-sm text-text-dark/70">
          ارسال نقاشی کودک فقط توسط والد یا سرپرست قانونی انجام می‌شود و امکان حذف داده‌ها در مراحل بعدی فراهم خواهد شد.
        </p>
      </Card>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-2">آماده‌سازی دستی در MVP</h3>
        <p className="text-sm text-text-dark/70">
          در این نسخه، جان‌بخشی به نقاشی به‌صورت خودکار انجام نمی‌شود. تیم کارتونا پس از بررسی ایمنی، خروجی را آماده می‌کند.
        </p>
      </Card>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-3">هزینه آبنباتی</h3>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-dark/70">هزینه نهایی</span>
          <div className="text-right">
            <span className="text-xl font-bold text-text-dark">—</span>
            <p className="text-xs text-text-dark/50">هزینه نهایی پس از اتصال سیستم سفارش، کیف آبنبات و نوع خروجی مشخص می‌شود.</p>
          </div>
        </div>
      </Card>

      <div className="flex justify-between gap-4 mt-6">
        <div className="sm:order-2">
          <Button type="submit" disabled>
            ثبت درخواست جان‌بخشی
          </Button>
        </div>
        <div className="sm:order-1">
          <a
            href="/dashboard"
            className="text-sm text-text-dark hover:text-text-dark/70"
          >
            بازگشت به داشبورد
          </a>
        </div>
      </div>

      <div className="mt-4 text-center">
        <p className="text-xs text-text-dark/50">
          ثبت واقعی درخواست پس از اتصال پایگاه داده و جریان سفارش فعال می‌شود.
        </p>
      </div>
    </div>
  );
}

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

export default function RequestVideoPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="درخواست ویدیوی کارتونی"
        description="درخواست ساخت یک ویدیوی کارتونی کوتاه و خصوصی را ثبت کنید. در MVP، درخواست‌ها به‌صورت دستی توسط تیم کارتونا بررسی و آماده می‌شوند."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-2">ویدیوی خصوصی برای خانواده</h3>
        <p className="text-sm text-text-dark/70">
          ویدیوهای کارتونا فقط برای والد و تیم بررسی کارتونا قابل مشاهده هستند. لطفاً از ارسال اطلاعات حساس یا درخواست شخصیت‌های مشهور و دارای کپی‌رایت خودداری کنید.
        </p>
      </Card>

      <Card className="mb-6">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">انتخاب شخصیت کارتونا</label>
              <div className="text-xs text-text-dark/60">مجموعة شخصیت‌های اصلی کارتونا</div>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">عنوان ویدیو</label>
              <input
                type="text"
                placeholder="مثلا: پرواز فرشتگان در شب"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">خلاصه داستان</label>
            <textarea
              placeholder="متن خود را اینجا بنویسید"
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30 min-h-[80px]"
              disabled
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">پیام یا مناسبت ویدیو</label>
              <input
                type="text"
                placeholder="مثلا: تولد، روز مادر"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">سبک ویدیو</label>
              <input
                type="text"
                placeholder="مثلا: انیمیشن دو بعدی، تکنیک لایو اکشن"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
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

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">یادداشت والد</label>
            <textarea
              placeholder="مثلا: کودک می‌خواهد اسباب‌بازی‌هایش بیدار شوند..."
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30 min-h-[60px]"
              disabled
            />
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
        <h3 className="font-semibold text-parent-navy mb-2">آماده‌سازی دستی در MVP</h3>
        <p className="text-sm text-text-dark/70">
          در این نسخه، درخواست ویدیو به‌صورت خودکار تولید نمی‌شود. تیم کارتونا پس از بررسی ایمنی، خروجی را آماده می‌کند.
        </p>
      </Card>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-3">هزینه آبنباتی</h3>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-dark/70">هزینه نهایی</span>
          <div className="text-right">
            <span className="text-xl font-bold text-text-dark">—</span>
            <p className="text-xs text-text-dark/50">هزینه نهایی پس از اتصال سیستم سفارش، کیف آبنبات و نوع ویدیو مشخص می‌شود.</p>
          </div>
        </div>
      </Card>

      <div className="flex justify-between gap-4 mt-6">
        <div className="sm:order-2">
          <Button type="submit" disabled>
            ثبت درخواست ویدیو
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

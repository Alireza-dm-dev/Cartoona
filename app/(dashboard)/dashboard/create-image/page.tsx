"use client";

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

export default function CreateImagePage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="ساخت تصویر کارتونی"
        description="درخواست ساخت یک تصویر کارتونی خصوصی را ثبت کنید. در MVP، درخواست‌ها بعداً توسط تیم کارتونا بررسی و آماده می‌شوند."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-2">درخواست خصوصی والدین</h3>
        <p className="text-sm text-text-dark/70">
          این درخواست فقط برای والد و تیم بررسی کارتونا قابل مشاهده است. لطفاً از ارسال اطلاعات حساس یا درخواست شخصیت‌های مشهور و دارای کپی‌رایت خودداری کنید.
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
              <label className="block text-sm font-medium text-text-dark">عنوان درخواست</label>
              <input
                type="text"
                placeholder="مثلا: پرهای مهتابی"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">توضیح صحنه</label>
            <textarea
              placeholder="متن خود را اینجا بنویسید"
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30 min-h-[80px]"
              disabled
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">سبک تصویر</label>
              <input
                type="text"
                placeholder="مثلا: روی رنگ، دستکاری شده"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">مناسبت یا موضوع</label>
              <input
                type="text"
                placeholder="مثلا: شب تابستانی، تولد"
                className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                disabled
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">یادداشت والد</label>
            <textarea
              placeholder="مثلا: کودک دوست دارد پروانه‌ها ببیند..."
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30 min-h-[60px]"
              disabled
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">فایل مرجع کودک / تصویر کمکی</label>
            <div className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/50">
              بارگذاری فایل در مراحل بعدی فعال می‌شود.
            </div>
          </div>
        </div>
      </Card>

      <Card variant="admin" className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-3">انتخاب شخصیت</h3>
        <div className="grid gap-3">
          {characters.map((character) => (
            <div
              key={character.name}
              className="flex items-center gap-3 p-3 rounded-lg border border-soft-border bg-soft-border/5"
            >
              <span className="text-2xl shrink-0">{character.emoji}</span>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-medium text-text-dark">{character.name}</h4>
                  <Badge variant="default" size="sm">
                    {categoryLabels[character.category] || character.category}
                  </Badge>
                </div>
                <p className="text-xs text-text-dark/60 mt-0.5">
                  {character.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-3">هزینه آبنباتی</h3>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-dark/70">هزینه نهایی</span>
          <div className="text-right">
            <span className="text-xl font-bold text-text-dark">—</span>
            <p className="text-xs text-text-dark/50">هزینه نهایی پس از اتصال سیستم سفارش و کیف آبنبات مشخص می‌شود.</p>
          </div>
        </div>
      </Card>

      <div className="flex justify-between gap-4 mt-6">
        <Button variant="secondary" className="sm:order-2" disabled>
          ثبت درخواست تصویر
        </Button>
        <Button
          variant="ghost"
          className="sm:order-1 text-xs"
          onClick={() => (window.location.href = "/dashboard")}
        >
          بازگشت به داشبورد
        </Button>
      </div>

      <div className="mt-4 text-center">
        <p className="text-xs text-text-dark/50">
          ثبت واقعی درخواست پس از اتصال پایگاه داده و جریان سفارش فعال می‌شود.
        </p>
      </div>
    </div>
  );
}

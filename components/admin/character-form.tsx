import React from "react";

interface CharacterFormProps {
  className?: string;
}

export function CharacterForm({ className = "" }: CharacterFormProps) {
  return (
    <div className={`${className}`}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">نام شخصیت</label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌نام شخصیت را اینجا بنویسید
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">ایموجی یا نماد</label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌🖼️ (آیکن انتخاب‌شده)
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-dark">توضیح کوتاه</label>
          <div className="h-20 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
            ‌توضیح کوتاه شخصیت را اینجا بنویسید
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">دسته‌بندی</label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌دسته‌بندی را انتخاب کنید
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">وضعیت فعال بودن</label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌وضعیت (فعال/غیرفعال)
            </div>
          </div>
        </div>

        <div className="pt-2">
          <p className="text-xs text-text-dark/50">
            افزودن شخصیت پس از اتصال دیتابیس و نقش ادمین فعال می‌شود.
          </p>
        </div>

        <div className="pt-4">
          <button
            type="submit"
            disabled
            className="w-full rounded-xl bg-[#C94470] px-5 py-2.5 text-sm font-medium text-white opacity-50 cursor-not-allowed"
          >
            افزودن شخصیت
          </button>
        </div>
      </div>
    </div>
  );
}

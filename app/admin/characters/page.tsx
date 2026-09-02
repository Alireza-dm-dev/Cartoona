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

export default function AdminCharactersPage() {
  return (
    <div>
      <PageHeader
        title="مدیریت شخصیت‌ها"
        description="مدیریت نمایشی شخصیت‌های اصلی کارتونا برای استفاده در درخواست‌های والدین."
      />
      <Card variant="admin" className="mb-8 border-soft-purple/20 bg-soft-purple/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🎭</span>
          <div>
            <h3 className="font-semibold text-parent-navy">اصل مهم شخصیت‌ها</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              شخصیت‌های کارتونا باید اصلی، امن و مناسب کودک باشند. استفاده از شخصیت‌های
              مشهور، دارای کپی‌رایت یا تقلید مستقیم از برندهای شناخته‌شده در این محصول
              مجاز نیست.
            </p>
          </div>
        </div>
      </Card>

      <Card variant="admin" className="mb-8 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-3">
          مدیریت شخصیت‌ها هنوز نمایشی است
        </h3>
        <p className="text-sm text-text-dark/70">
          در این مرحله ادمین می‌تواند ساختار ایجاد، ویرایش و غیرفعال‌سازی شخصیت‌ها را مشاهده کند،
          اما ذخیره‌سازی واقعی پس از اتصال پایگاه داده و نقش ادمین فعال می‌شود.
        </p>
      </Card>

      <Card variant="admin" className="mb-8">
        <h3 className="font-semibold text-parent-navy mb-4">افزودن شخصیت جدید</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">
              نام شخصیت
            </label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌نام شخصیت را اینجا بنویسید
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">
              ایموجی یا نماد
            </label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌🖼️ (آیکن انتخاب‌شده)
            </div>
          </div>
        </div>

        <div className="space-y-2 mt-4">
          <label className="block text-sm font-medium text-text-dark">
            توضیح کوتاه
          </label>
          <div className="h-20 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
            ‌توضیح کوتاه شخصیت را اینجا بنویسید
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">
              دسته‌بندی
            </label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌دسته‌بندی را انتخاب کنید
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">
              وضعیت فعال بودن
            </label>
            <div className="h-10 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/40">
              ‌وضعیت (فعال/غیرفعال)
            </div>
          </div>
        </div>

        <div className="pt-2 mt-4">
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
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {characters.map((character) => (
          <Card key={character.name} variant="admin">
            <div className="flex items-start gap-3">
              <span className="text-2xl shrink-0">{character.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-text-dark">{character.name}</h3>
                  <Badge variant="success">فعال</Badge>
                </div>
                <p className="text-xs text-text-dark/50 mt-0.5">
                  {categoryLabels[character.category] || character.category}
                </p>
                <p className="mt-1 text-xs text-text-dark/60 leading-relaxed">
                  {character.description}
                </p>
              </div>
            </div>
            <div className="mt-3 text-xs text-text-dark/40">
              استفاده در درخواست‌ها: نمایشی
            </div>
            <div className="mt-3">
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled>
                  ویرایش شخصیت
                </Button>
                <Button variant="secondary" size="sm" disabled>
                  غیرفعال‌سازی
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card variant="admin" className="mt-8">
        <h3 className="font-semibold text-parent-navy mb-3">
          قوانین شخصیت‌های کارتونا
        </h3>
        <ul className="space-y-2 text-sm text-text-dark/70 list-disc pr-4">
          <li>شخصیت باید اصلی و متعلق به کارتونا باشد.</li>
          <li>استفاده از شخصیت‌های مشهور یا دارای کپی‌رایت مجاز نیست.</li>
          <li>
            شخصیت باید برای کودک امن، دوستانه و قابل استفاده در محتوای خصوصی باشد.
          </li>
          <li>
            غیرفعال‌سازی شخصیت، آن را از انتخاب‌های آینده پنهان می‌کند اما سوابق قبلی را حذف نمی‌کند.
          </li>
        </ul>
      </Card>

      <p className="mt-6 text-xs text-text-dark/30 text-center">
        فرم‌های ایجاد و ویرایش شخصیت در مراحل بعدی و پس از تکمیل نقش ادمین اضافه می‌شوند.
      </p>
    </div>
  );
}

import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const privacyLabels: Record<string, string> = {
  private: "خصوصی",
  parent_only: "فقط والد",
  needs_review: "نیازمند بررسی والد",
};

const privacyVariants: Record<string, "success" | "info" | "warning"> = {
  private: "success",
  parent_only: "info",
  needs_review: "warning",
};

interface MockProfile {
  id: string;
  label: string;
  age: string;
  interests: string;
  preferredStyle: string;
  favoriteCharacter: string;
  requestCount: number;
  privacy: string;
  parentNote: string;
}

const profiles: MockProfile[] = [
  {
    id: "CH-001",
    label: "پسر بزرگ",
    age: "۷ سال",
    interests: "دایناسور، فضا و ابرقهرمان‌ها",
    preferredStyle: "کارتونی شاد با رنگ‌های روشن",
    favoriteCharacter: "کاپیتان آبنبات",
    requestCount: 2,
    privacy: "private",
    parentNote: "علاقه زیادی به داستان‌های فضایی دارد.",
  },
  {
    id: "CH-002",
    label: "دختر کوچک",
    age: "۵ سال",
    interests: "شاهزاده‌ها، گربه و نقاشی",
    preferredStyle: "نرم و فانتزی با رنگ‌های پاستلی",
    favoriteCharacter: "پرنسس لوما",
    requestCount: 1,
    privacy: "private",
    parentNote: "نقاشی کشیدن را خیلی دوست دارد.",
  },
  {
    id: "CH-003",
    label: "پسر کوچک",
    age: "۳ سال",
    interests: "ماشین، حیوانات و موسیقی",
    preferredStyle: "ساده و شاد با شخصیت‌های دوستانه",
    favoriteCharacter: "داینو دودو",
    requestCount: 0,
    privacy: "needs_review",
    parentNote: "تازه اضافه شده — اطلاعات اولیه ثبت شود.",
  },
];

export default function ChildrenPage() {
  return (
    <div>
      <PageHeader
        title="پروفایل‌های کودک"
        description="پروفایل‌های کودک فقط برای کمک به ساخت درخواست‌های کارتونی خصوصی استفاده می‌شوند و تحت کنترل والد هستند."
      />
      <Card variant="admin" className="mb-8 border-sky-blue/20 bg-sky-blue/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">👤</span>
          <div>
            <h3 className="font-semibold text-parent-navy">کنترل کامل با والدین</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              در کارتونا کودک حساب مستقل، ورود جداگانه یا پروفایل عمومی ندارد. همه
              اطلاعات فقط توسط والد مدیریت می‌شود.
            </p>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {profiles.map((profile) => (
          <Card key={profile.id} variant="admin">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-soft-border/50 text-lg text-text-dark/30">
                👤
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-text-dark">{profile.label}</h3>
                  <Badge variant={privacyVariants[profile.privacy]}>{privacyLabels[profile.privacy]}</Badge>
                </div>
                <p className="text-xs text-text-dark/50">{profile.age}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs text-text-dark/50">
              <div className="flex justify-between">
                <span>علاقه‌مندی‌ها</span>
                <span className="text-text-dark/70">{profile.interests}</span>
              </div>
              <div className="flex justify-between">
                <span>سبک موردنظر</span>
                <span className="text-text-dark/70">{profile.preferredStyle}</span>
              </div>
              <div className="flex justify-between">
                <span>شخصیت محبوب</span>
                <span className="text-text-dark/70">{profile.favoriteCharacter}</span>
              </div>
              <div className="flex justify-between">
                <span>درخواست‌ها</span>
                <span className="text-text-dark/70">{profile.requestCount} مورد</span>
              </div>
            </div>
            <div className="mt-3 border-t border-soft-border pt-2 text-xs text-text-dark/40">
              {profile.parentNote}
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" disabled>
                ویرایش پروفایل
              </Button>
              <Button variant="danger" size="sm" disabled>
                حذف پروفایل
              </Button>
            </div>
          </Card>
        ))}
        <Card variant="admin" className="flex items-center justify-center border-dashed border-soft-border py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="text-2xl text-text-dark/20" aria-hidden="true">+</span>
            <div>
              <p className="text-sm font-medium text-text-dark/50">ایجاد پروفایل جدید</p>
              <p className="mt-1 text-xs text-text-dark/30">
                افزودن پروفایل کودک در مراحل بعدی و پس از تکمیل حساب کاربری امکان‌پذیر است.
              </p>
            </div>
            <Button variant="secondary" size="sm" disabled>
              افزودن پروفایل کودک
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

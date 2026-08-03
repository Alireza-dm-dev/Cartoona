import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

const stats = [
  { label: "درخواست‌های در انتظار بررسی", value: "—" },
  { label: "درخواست‌های در حال انجام", value: "—" },
  { label: "فایل‌های آماده تحویل", value: "—" },
  { label: "کاربران ثبت‌شده", value: "—" },
];

const suggestedActions = [
  "بررسی درخواست‌های جدید والدین",
  "پیگیری درخواست‌های در حال انجام",
  "آماده‌سازی فایل‌های نهایی برای تحویل",
  "بررسی موارد نیازمند بازبینی ایمنی",
];

export default function AdminDashboardPage() {
  return (
    <div>
      <PageHeader
        title="داشبورد مدیریت"
        description="نمای کلی وضعیت درخواست‌ها، رسانه‌ها، کاربران و فعالیت‌های مهم کارتونا."
      />
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} variant="admin">
            <p className="text-sm text-text-dark/60">{stat.label}</p>
            <p className="mt-1 text-2xl font-bold text-parent-navy">{stat.value}</p>
          </Card>
        ))}
      </div>
      <Card variant="admin" className="mb-8">
        <h2 className="mb-3 font-semibold text-parent-navy">اقدام‌های پیشنهادی</h2>
        <ul className="flex flex-col gap-2">
          {suggestedActions.map((action) => (
            <li key={action} className="flex items-center gap-2 text-sm text-text-dark/70">
              <span className="h-1.5 w-1.5 rounded-full bg-candy-pink shrink-0" />
              {action}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

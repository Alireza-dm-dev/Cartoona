import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CandyBalanceBadge } from "@/components/ui/candy-balance-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const typeLabels: Record<string, string> = {
  image: "تصویر کارتونی",
  video: "ویدیوی کارتونی",
  drawing_animation: "جان‌بخشی به نقاشی",
};

const statusLabels: Record<string, string> = {
  pending_review: "در انتظار بررسی",
  in_progress: "در حال انجام",
  ready: "آماده دریافت",
};

const statusVariants: Record<string, "warning" | "info" | "success"> = {
  pending_review: "warning",
  in_progress: "info",
  ready: "success",
};

interface MockRequest {
  id: string;
  title: string;
  type: string;
  status: string;
  date: string;
  candyCost: number;
}

const recentRequests: MockRequest[] = [
  {
    id: "REQ-001",
    title: "تصویر تولد کاپیتان آبنبات",
    type: "image",
    status: "pending_review",
    date: "۱۴ دی ۱۴۰۴",
    candyCost: 15,
  },
  {
    id: "REQ-002",
    title: "ویدیوی تشویقی با پرنسس لوما",
    type: "video",
    status: "in_progress",
    date: "۱۲ دی ۱۴۰۴",
    candyCost: 45,
  },
  {
    id: "REQ-003",
    title: "جان‌بخشی به نقاشی اسب",
    type: "drawing_animation",
    status: "ready",
    date: "۱۰ دی ۱۴۰۴",
    candyCost: 30,
  },
  {
    id: "REQ-005",
    title: "داستان شب با پری نیلا",
    type: "video",
    status: "pending_review",
    date: "۱۵ دی ۱۴۰۴",
    candyCost: 45,
  },
];

const quickActions = [
  {
    href: "/dashboard/create-image",
    emoji: "🖼️",
    title: "ساخت تصویر کارتونی",
    description: "یک تصویر کارتونی خصوصی برای کودک بسازید.",
  },
  {
    href: "/dashboard/request-video",
    emoji: "🎬",
    title: "درخواست ویدیوی کارتونی",
    description: "یک ویدیوی کوتاه کارتونی بر اساس سناریوی والد ثبت کنید.",
  },
  {
    href: "/dashboard/animate-drawing",
    emoji: "✏️",
    title: "جان‌بخشی به نقاشی",
    description: "نقاشی کودک را به یک خروجی کارتونی متحرک تبدیل کنید.",
  },
];

const summaryCards = [
  {
    emoji: "🍬",
    label: "آبنبات‌های باقی‌مانده",
    value: "—",
    helper: "پس از اتصال پرداخت و کیف اعتبار نمایش داده می‌شود.",
  },
  {
    emoji: "📋",
    label: "درخواست‌های فعال",
    value: "—",
    helper: "درخواست‌های در حال بررسی یا آماده‌سازی.",
  },
  {
    emoji: "👤",
    label: "پروفایل‌های کودک",
    value: "—",
    helper: "فقط برای والد قابل مشاهده است.",
  },
  {
    emoji: "📦",
    label: "فایل‌های آماده دریافت",
    value: "—",
    helper: "خروجی‌های نهایی پس از آماده شدن نمایش داده می‌شوند.",
  },
];

export default function ParentDashboardPage() {
  return (
    <div>
      <PageHeader
        title="داشبورد والدین"
        description="از اینجا می‌توانید درخواست‌های کارتونی، پروفایل‌های کودک و وضعیت آبنبات‌های خود را به‌صورت خصوصی مدیریت کنید."
        action={<CandyBalanceBadge balance={0} />}
      />

      <Card variant="admin" className="mb-8 border-sky-blue/20 bg-sky-blue/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🛡️</span>
          <div>
            <h3 className="font-semibold text-parent-navy">یادآوری حریم خصوصی</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              در کارتونا همه درخواست‌ها و فایل‌های کودک خصوصی هستند و فقط توسط والد و
              تیم بررسی کارتونا قابل مشاهده‌اند.
            </p>
          </div>
        </div>
      </Card>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map((card) => (
          <Card key={card.label} variant="admin">
            <span className="text-xl" aria-hidden="true">{card.emoji}</span>
            <p className="mt-2 text-sm text-text-dark/60">{card.label}</p>
            <p className="mt-1 text-2xl font-bold text-parent-navy">{card.value}</p>
            <p className="mt-1 text-xs text-text-dark/40">{card.helper}</p>
          </Card>
        ))}
      </div>

      <section className="mb-8">
        <h2 className="mb-4 text-lg font-semibold text-parent-navy">شروع سریع</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {quickActions.map((action) => (
            <Link key={action.href} href={action.href}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <div className="mb-2 text-2xl" aria-hidden="true">{action.emoji}</div>
                <h3 className="font-semibold text-text-dark">{action.title}</h3>
                <p className="mt-1 text-xs text-text-dark/60">{action.description}</p>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-4 text-lg font-semibold text-parent-navy">وضعیت نمونه درخواست‌ها</h2>
        <div className="flex flex-col gap-3">
          {recentRequests.map((req) => (
            <Link key={req.id} href="/dashboard/orders">
              <Card variant="admin" className="transition-shadow hover:shadow-md">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-text-dark">{req.title}</h3>
                      <span className="text-xs text-text-dark/40">({req.id})</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant="default">{typeLabels[req.type]}</Badge>
                      <Badge variant={statusVariants[req.status]}>{statusLabels[req.status]}</Badge>
                      <span className="text-xs text-text-dark/40">{req.date}</span>
                      <span className="text-xs text-text-dark/40">{req.candyCost} آبنبات</span>
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <div>
        <Button variant="secondary" disabled>
          مدیریت پرداخت و آبنبات‌ها
        </Button>
      </div>

      <p className="mt-8 text-xs text-text-dark/30 text-center">
        اتصال به حساب کاربری، احراز هویت والد و داده‌های واقعی در مراحل بعدی افزوده می‌شوند.
      </p>
    </div>
  );
}

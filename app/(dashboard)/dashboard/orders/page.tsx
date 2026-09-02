import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import type { OrderStatus } from "@/types/app";

const categoryLabels: Record<string, string> = {
  Adventure: "ماجراجویی",
  Fantasy: "فانتازی",
  Animals: "حیوانات",
  "Sci-Fi": "علمی-تخیلی",
  Education: "آموزشی",
};

const orderTypes: Record<string, string> = {
  image: "تصویر کارتونی",
  video: "ویدیوی کارتونی",
  drawing_animation: "جان‌بخشی به نقاشی",
};

const mockOrders = [
  {
    id: "ORD-2024-001",
    title: "پرواز پرهای مهتابی",
    type: "image",
    status: "ready",
    created: "۰۲ فروردین ۱۴۰۳",
    candyCost: 150,
    childProfile: "کاراکتر داینو دودو",
    parentNote: "کودک از پروانه‌های رنگارنگ خوشش می‌آید.",
  },
  {
    id: "ORD-2024-002",
    title: "شب تابستانی در جنگل کاپیتان کندی",
    type: "video",
    status: "in_progress",
    created: "۱۵ اسفند ۱۴۰۳",
    candyCost: 500,
    childProfile: "پرنسس لومه",
    parentNote: "معدن طلایی رو ببین!",
  },
  {
    id: "ORD-2024-003",
    title: "دانشمند پاندا و کتاب جادویی",
    type: "drawing_animation",
    status: "pending_review",
    created: "۲۶ بهمن ۱۴۰۳",
    candyCost: 300,
    childProfile: "برادر کوچکتر",
    parentNote: "نقاشی آفتاب و ستاره‌ها.",
  },
  {
    id: "ORD-2024-004",
    title: "ماجرای قهرمان فضایی کاپیتان کندی",
    type: "image",
    status: "delivered",
    created: "۱۰ دی ۱۴۰۳",
    candyCost: 100,
    childProfile: "دفتر نقاشی روزانه",
    parentNote: "تصویر ذخیره شده.",
  },
  {
    id: "ORD-2024-005",
    title: "ماجرای قهرمان فضایی کاپیتان کندی",
    type: "video",
    status: "rejected",
    created: "۲۵ آبان ۱۴۰۳",
    candyCost: 200,
    childProfile: "نامه رفع استرس",
    parentNote: "نیاز به بازبینی است.",
  },
  {
    id: "ORD-2024-006",
    title: "ماجرای قهرمان فضایی کاپیتان کندی",
    type: "drawing_animation",
    status: "in_progress",
    created: "۱۵ مهر ۱۴۰۳",
    candyCost: 250,
    childProfile: "کاریکاتور روزانه",
    parentNote: "پازل روبوکو آسان.",
  },
];

export default function OrdersPage() {
  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="درخواست‌های من"
        description="وضعیت درخواست‌های تصویر، ویدیو و جان‌بخشی به نقاشی را به‌صورت خصوصی دنبال کنید."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-2">درخواست‌ها خصوصی هستند</h3>
        <p className="text-sm text-text-dark/70">
          درخواست‌ها، فایل‌های کودک و خروجی‌های نهایی فقط برای والد و تیم بررسی کارتونا قابل مشاهده هستند و به‌صورت عمومی منتشر نمی‌شوند.
        </p>
      </Card>

      <div className="grid gap-6 mb-8">
        {mockOrders.map((order) => (
          <Card key={order.id} variant="admin">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-3">
                  <h3 className="font-semibold text-text-dark">{order.id}</h3>
                  <Badge variant="info" size="sm">
                    {orderTypes[order.type]}
                  </Badge>
                  <OrderStatusBadge status={order.status as OrderStatus} />
                </div>
                <h4 className="font-medium text-text-dark mb-2">{order.title}</h4>
                <div className="flex items-center gap-4 text-xs text-text-dark/60 mb-2">
                  <span>ایجاد شده در: {order.created}</span>
                  <span>{order.candyCost} آبنبات</span>
                  <span>پروفایل کودک: {order.childProfile}</span>
                </div>
                <p className="text-xs text-text-dark/70 bg-soft-border/10 p-2 rounded">
                  یادداشت والد: {order.parentNote}
                </p>
              </div>
              <div className="flex-shrink-0">
                <Link href={`/dashboard/orders/${order.id}`}>
                  <Button variant="secondary" size="sm">مشاهده جزئیات</Button>
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-3">راهنمای وضعیت‌ها</h3>
        <div className="space-y-2 text-sm text-text-dark/70">
          <div className="flex gap-3">
            <Badge variant="warning" size="sm">در انتظار بررسی</Badge>
            <span>درخواست توسط تیم کارتونا بررسی می‌شود.</span>
          </div>
          <div className="flex gap-3">
            <Badge variant="info" size="sm">در حال انجام</Badge>
            <span>خروجی در حال تولید یا آماده‌سازی دستی است.</span>
          </div>
          <div className="flex gap-3">
            <Badge variant="success" size="sm">آماده تحویل</Badge>
            <span>فایل نهایی آماده شده و در مراحل بعدی قابل دریافت خواهد بود.</span>
          </div>
          <div className="flex gap-3">
            <Badge variant="success" size="sm">تحویل داده شده</Badge>
            <span>خروجی نهایی قبلاً تحویل داده شده است.</span>
          </div>
          <div className="flex gap-3">
            <Badge variant="danger" size="sm">رد شده</Badge>
            <span>درخواست نیاز به بررسی یا اصلاح توسط والد دارد.</span>
          </div>
        </div>
      </Card>

      <Card className="mb-6">
        <h3 className="font-semibold text-parent-navy mb-2">امکانات بعدی</h3>
        <p className="text-sm text-text-dark/70">
          مشاهده جزئیات، دریافت فایل نهایی و پیگیری دقیق وضعیت پس از اتصال پایگاه داده و جریان سفارش فعال می‌شود.
        </p>
      </Card>
    </div>
  );
}

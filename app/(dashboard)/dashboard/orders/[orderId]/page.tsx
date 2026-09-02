import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import type { OrderStatus } from "@/types/app";

const orderTypes: Record<string, string> = {
  image: "تصویر کارتونی",
  video: "ویدیوی کارتونی",
  drawing_animation: "جان‌بخشی به نقاشی",
};

interface MockOrder {
  id: string;
  title: string;
  type: string;
  status: string;
  created: string;
  candyCost: number;
  childProfile: string;
  parentNote: string;
}

const mockOrders: MockOrder[] = [
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
    childProfile: "دفتر نقاشه روزانه",
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

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const order = mockOrders.find((o) => o.id === orderId);

  if (!order) {
    return (
      <div className="mx-auto max-w-[880px]">
        <PageHeader
          title="درخواست پیدا نشد"
          description="درخواستی با این شناسه در اطلاعات نمایشی موجود نیست."
        />
        <Card>
          <div className="flex flex-col items-center text-center">
            <div className="mb-3 text-4xl" aria-hidden="true">🔍</div>
            <p className="text-sm text-text-dark/60">
              شناسه جستجو شده:
            </p>
            <p className="mt-1 text-xs text-text-dark/40" dir="ltr">{orderId}</p>
          </div>
        </Card>
        <div className="mt-6">
          <Link href="/dashboard/orders">
            <Button variant="secondary">بازگشت به درخواست‌ها</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="جزئیات درخواست"
        description="پیگیری وضعیت و جزئیات درخواست شما. جدول زمانی دقیق پیگیری و فایل‌های نهایی تحویلی در مراحل بعدی در اینجا نمایش داده خواهند شد."
      />

      <Card className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-text-dark/50">شناسه درخواست</p>
            <h2 className="text-lg font-semibold text-parent-navy" dir="ltr">{order.id}</h2>
          </div>
          <OrderStatusBadge status={order.status as OrderStatus} />
        </div>
      </Card>

      <Card className="mb-6">
        <h3 className="mb-3 font-semibold text-parent-navy">اطلاعات درخواست</h3>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-text-dark/50">نوع درخواست</span>
            <span className="text-text-dark">{orderTypes[order.type] ?? order.type}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-dark/50">عنوان</span>
            <span className="text-text-dark">{order.title}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-dark/50">تاریخ ثبت</span>
            <span className="text-text-dark">{order.created}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-text-dark/50">وضعیت</span>
            <OrderStatusBadge status={order.status as OrderStatus} />
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-dark/50">هزینه آب‌نباتی</span>
            <span className="text-text-dark">{order.candyCost} آب‌نبات</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-dark/50">پروفایل کودک</span>
            <span className="text-text-dark">{order.childProfile}</span>
          </div>
          <div className="flex flex-col gap-1 border-t border-soft-border pt-3">
            <span className="text-text-dark/50">یادداشت والد</span>
            <span className="text-text-dark">{order.parentNote}</span>
          </div>
        </div>
      </Card>

      <Card variant="admin" className="mb-6 border-sky-blue/20 bg-sky-blue/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🛡️</span>
          <div>
            <h3 className="font-semibold text-parent-navy">پیگیری و تحویل</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              این درخواست و فایل‌های نهایی آن فقط برای والد و تیم بررسی کارتونا قابل
              مشاهده هستند. پس از آماده‌سازی، فایل نهایی در همین صفحه نمایش داده خواهد شد.
            </p>
          </div>
        </div>
      </Card>

      <div className="flex justify-start">
        <Link href="/dashboard/orders">
          <Button variant="secondary">بازگشت به درخواست‌ها</Button>
        </Link>
      </div>
    </div>
  );
}

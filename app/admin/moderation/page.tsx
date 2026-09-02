import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const riskLabels: Record<string, string> = {
  low: "کم",
  medium: "متوسط",
  high: "بالا",
};

const riskVariants: Record<string, "success" | "warning" | "danger"> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

const statusLabels: Record<string, string> = {
  pending_review: "در انتظار بررسی",
  needs_admin_decision: "نیازمند تصمیم ادمین",
  cleared: "تایید ایمنی",
  rejected: "رد شده",
};

const statusVariants: Record<string, "warning" | "danger" | "success" | "danger"> = {
  pending_review: "warning",
  needs_admin_decision: "danger",
  cleared: "success",
  rejected: "danger",
};

interface MockModerationItem {
  id: string;
  requestId: string;
  requestTitle: string;
  parentName: string;
  reason: string;
  risk: string;
  status: string;
  createdAt: string;
  adminNote: string;
}

const items: MockModerationItem[] = [
  {
    id: "MOD-001",
    requestId: "REQ-004",
    requestTitle: "خاطره خانوادگی با داینو دودو",
    parentName: "امیر حسینی",
    reason: "بررسی رضایت والد — نیازمند تأیید مجدد",
    risk: "medium",
    status: "pending_review",
    createdAt: "۸ دی ۱۴۰۴",
    adminNote: "رضایت اولیه ثبت شده است. بازبینی دستی لازم است.",
  },
  {
    id: "MOD-002",
    requestId: "REQ-005",
    requestTitle: "داستان شب با پری نیلا",
    parentName: "الناز کریمی",
    reason: "بررسی فایل مرجع بارگذاری‌شده",
    risk: "low",
    status: "pending_review",
    createdAt: "۱۵ دی ۱۴۰۴",
    adminNote: "تصویر مرجع بارگذاری شده. بررسی محتوایی انجام شود.",
  },
  {
    id: "MOD-003",
    requestId: "REQ-001",
    requestTitle: "تصویر تولد کاپیتان آبنبات",
    parentName: "مریم احمدی",
    reason: "بررسی عدم استفاده از شخصیت مشهور",
    risk: "low",
    status: "cleared",
    createdAt: "۱۴ دی ۱۴۰۴",
    adminNote: "شخصیت اختصاصی کارتونا — تایید شد.",
  },
  {
    id: "MOD-004",
    requestId: "REQ-002",
    requestTitle: "ویدیوی تشویقی با پرنسس لوما",
    parentName: "سعید رضایی",
    reason: "بررسی متن درخواست والد",
    risk: "low",
    status: "cleared",
    createdAt: "۱۲ دی ۱۴۰۴",
    adminNote: "متن درخواست مناسب و شفاف است.",
  },
  {
    id: "MOD-005",
    requestId: "REQ-006",
    requestTitle: "ماجراجویی فضایی با سانی",
    parentName: "رضا نوری",
    reason: "بررسی آماده بودن خروجی برای تحویل خصوصی",
    risk: "low",
    status: "needs_admin_decision",
    createdAt: "۱۳ دی ۱۴۰۴",
    adminNote: "خروجی آماده است. تأیید نهایی ادمین لازم است.",
  },
  {
    id: "MOD-006",
    requestId: "REQ-003",
    requestTitle: "جان‌بخشی به نقاشی اسب",
    parentName: "زهرا محمدی",
    reason: "بررسی فایل مرجع بارگذاری‌شده",
    risk: "medium",
    status: "needs_admin_decision",
    createdAt: "۱۰ دی ۱۴۰۴",
    adminNote: "نقاشی کودک اسکن شده. کیفیت قابل قبول است. نیازمند تصمیم نهایی.",
  },
  {
    id: "MOD-007",
    requestId: "REQ-007",
    requestTitle: "جان‌بخشی به نقاشی گربه",
    parentName: "فاطمه سعیدی",
    reason: "بررسی عدم استفاده از شخصیت مشهور",
    risk: "low",
    status: "pending_review",
    createdAt: "۱۱ دی ۱۴۰۴",
    adminNote: "نقاشی کودک برای بررسی بارگذاری شده است.",
  },
  {
    id: "MOD-008",
    requestId: "REQ-008",
    requestTitle: "تصویر تشویقی با روبو بوبو",
    parentName: "محمد اکبری",
    reason: "بررسی رضایت والد",
    risk: "high",
    status: "pending_review",
    createdAt: "۱۶ دی ۱۴۰۴",
    adminNote: "رضایت والد ثبت نشده. بررسی فوری نیاز است.",
  },
];

export default function AdminModerationPage() {
  return (
    <div>
      <PageHeader
        title="بررسی ایمنی"
        description="نمایش درخواست‌هایی که برای حفظ حریم خصوصی کودک، رضایت والد و ایمنی محتوا نیازمند بررسی دستی هستند."
      />
      <Card variant="admin" className="mb-8 border-mint-green/20 bg-mint-green/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🛡️</span>
          <div>
            <h3 className="font-semibold text-parent-navy">اصل بررسی دستی</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              هیچ محتوای مربوط به کودک بدون بررسی ادمین، رضایت والد و رعایت قوانین
              حریم خصوصی برای تحویل آماده نمی‌شود.
            </p>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map((item) => (
          <Card key={item.id} variant="admin">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold text-text-dark">{item.requestTitle}</h3>
                <span className="text-xs text-text-dark/40">{item.id} — {item.requestId}</span>
              </div>
            </div>
            <p className="mt-2 text-sm text-text-dark/60">{item.parentName}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant={riskVariants[item.risk]}>{riskLabels[item.risk]}</Badge>
              <Badge variant={statusVariants[item.status]}>{statusLabels[item.status]}</Badge>
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs text-text-dark/50">
              <div className="flex justify-between">
                <span>دلیل بررسی</span>
                <span className="text-text-dark/70">{item.reason}</span>
              </div>
              <div className="flex justify-between">
                <span>تاریخ ثبت</span>
                <span className="text-text-dark/70">{item.createdAt}</span>
              </div>
            </div>
            <div className="mt-3 border-t border-soft-border pt-2 text-xs text-text-dark/40">
              {item.adminNote}
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" disabled>
                تایید ایمنی
              </Button>
              <Button variant="danger" size="sm" disabled>
                رد درخواست
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const typeLabels: Record<string, string> = {
  reference_image: "تصویر مرجع",
  child_drawing: "نقاشی کودک",
  helper_file: "فایل کمکی",
  final_image: "خروجی تصویر",
  final_video: "خروجی ویدیو",
};

const sourceLabels: Record<string, string> = {
  parent_upload: "بارگذاری والد",
  admin_output: "خروجی ادمین",
  system_placeholder: "جایگاه نمایشی",
};

const statusLabels: Record<string, string> = {
  pending_review: "در انتظار بررسی",
  approved: "تایید شده",
  needs_review: "نیازمند بازبینی",
  ready_for_delivery: "آماده تحویل",
};

const statusVariants: Record<string, "warning" | "success" | "danger" | "info"> = {
  pending_review: "warning",
  approved: "success",
  needs_review: "danger",
  ready_for_delivery: "info",
};

interface MockMedia {
  id: string;
  label: string;
  type: string;
  requestId: string;
  parentName: string;
  source: string;
  status: string;
  date: string;
  safetyNote: string;
}

const mediaItems: MockMedia[] = [
  {
    id: "MED-001",
    label: "عکس مرجع کودک",
    type: "reference_image",
    requestId: "REQ-001",
    parentName: "مریم احمدی",
    source: "parent_upload",
    status: "approved",
    date: "۱۴ دی ۱۴۰۴",
    safetyNote: "فاقد محتوای حساس",
  },
  {
    id: "MED-002",
    label: "نقاشی اسب با مداد رنگی",
    type: "child_drawing",
    requestId: "REQ-003",
    parentName: "زهرا محمدی",
    source: "parent_upload",
    status: "approved",
    date: "۱۰ دی ۱۴۰۴",
    safetyNote: "فاقد محتوای حساس",
  },
  {
    id: "MED-003",
    label: "خروجی نهایی تصویر تولد",
    type: "final_image",
    requestId: "REQ-001",
    parentName: "مریم احمدی",
    source: "admin_output",
    status: "ready_for_delivery",
    date: "۱۵ دی ۱۴۰۴",
    safetyNote: "تایید نهایی شده",
  },
  {
    id: "MED-004",
    label: "فیلم مرجع خانوادگی",
    type: "reference_image",
    requestId: "REQ-002",
    parentName: "سعید رضایی",
    source: "parent_upload",
    status: "pending_review",
    date: "۱۲ دی ۱۴۰۴",
    safetyNote: "نیازمند بررسی محتوا",
  },
  {
    id: "MED-005",
    label: "نقاشی گربه با آبرنگ",
    type: "child_drawing",
    requestId: "REQ-007",
    parentName: "فاطمه سعیدی",
    source: "parent_upload",
    status: "needs_review",
    date: "۱۱ دی ۱۴۰۴",
    safetyNote: "کیفیت اسکن پایین — بازبینی شود",
  },
  {
    id: "MED-006",
    label: "انیمیشن نهایی نقاشی اسب",
    type: "final_video",
    requestId: "REQ-003",
    parentName: "زهرا محمدی",
    source: "admin_output",
    status: "ready_for_delivery",
    date: "۱۵ دی ۱۴۰۴",
    safetyNote: "تایید نهایی شده",
  },
  {
    id: "MED-007",
    label: "عکس مرجع کودک",
    type: "reference_image",
    requestId: "REQ-005",
    parentName: "الناز کریمی",
    source: "parent_upload",
    status: "pending_review",
    date: "۱۵ دی ۱۴۰۴",
    safetyNote: "نیازمند بررسی محتوا",
  },
  {
    id: "MED-008",
    label: "نقاشی فضایی با مداد شمعی",
    type: "child_drawing",
    requestId: "REQ-006",
    parentName: "رضا نوری",
    source: "parent_upload",
    status: "approved",
    date: "۱۳ دی ۱۴۰۴",
    safetyNote: "فاقد محتوای حساس",
  },
];

export default function AdminMediaPage() {
  return (
    <div>
      <PageHeader
        title="رسانه‌ها"
        description="مدیریت نمایشی فایل‌های ورودی والدین، فایل‌های مرجع و خروجی‌های آماده تحویل."
      />
      <Card variant="admin" className="mb-8 border-sky-blue/20 bg-sky-blue/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🛡️</span>
          <div>
            <h3 className="font-semibold text-parent-navy">یادآوری ایمنی</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              فایل‌های کودک فقط برای بررسی داخلی ادمین نمایش داده می‌شوند و نباید
              به‌صورت عمومی منتشر شوند.
            </p>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mediaItems.map((item) => (
          <Card key={item.id} variant="admin">
            <div className="mb-3 aspect-video rounded-lg bg-gradient-to-br from-soft-border/50 to-cream flex items-center justify-center text-xs text-text-dark/20">
              پیش‌نمایش
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="default">{typeLabels[item.type]}</Badge>
              <Badge variant={statusVariants[item.status]}>{statusLabels[item.status]}</Badge>
            </div>
            <h3 className="mt-3 font-semibold text-text-dark">{item.label}</h3>
            <div className="mt-2 flex flex-col gap-1 text-xs text-text-dark/50">
              <div className="flex justify-between">
                <span>شناسه درخواست</span>
                <span className="text-text-dark/70" dir="ltr">{item.requestId}</span>
              </div>
              <div className="flex justify-between">
                <span>والد</span>
                <span className="text-text-dark/70">{item.parentName}</span>
              </div>
              <div className="flex justify-between">
                <span>منبع</span>
                <span className="text-text-dark/70">{sourceLabels[item.source]}</span>
              </div>
              <div className="flex justify-between">
                <span>تاریخ</span>
                <span className="text-text-dark/70">{item.date}</span>
              </div>
            </div>
            <div className="mt-3 border-t border-soft-border pt-2 text-xs text-text-dark/40">
              {item.safetyNote}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

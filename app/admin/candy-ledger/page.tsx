import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const typeLabels: Record<string, string> = {
  purchase: "خرید آبنبات",
  request_charge: "مصرف برای درخواست",
  admin_adjustment: "اصلاح ادمین",
  refund_placeholder: "جایگاه بازگشت اعتبار",
  bonus: "اعتبار هدیه",
};

const typeVariants: Record<string, "default" | "success" | "warning" | "info"> = {
  purchase: "success",
  request_charge: "info",
  admin_adjustment: "warning",
  refund_placeholder: "info",
  bonus: "default",
};

const statusLabels: Record<string, string> = {
  completed: "ثبت شده",
  pending: "در انتظار بررسی",
  cancelled: "لغو شده",
  placeholder: "نمایشی",
};

const statusVariants: Record<string, "success" | "warning" | "danger" | "default"> = {
  completed: "success",
  pending: "warning",
  cancelled: "danger",
  placeholder: "default",
};

interface MockTransaction {
  id: string;
  parentName: string;
  requestId: string | null;
  type: string;
  amount: string;
  balancePlaceholder: string;
  status: string;
  createdAt: string;
  note: string;
}

const transactions: MockTransaction[] = [
  {
    id: "CND-001",
    parentName: "مریم احمدی",
    requestId: "REQ-001",
    type: "request_charge",
    amount: "-۳۰ 🍬",
    balancePlaceholder: "۱۲۵ 🍬",
    status: "completed",
    createdAt: "۱۵ دی ۱۴۰۴",
    note: "مصرف برای درخواست تصویر تولد کاپیتان آبنبات",
  },
  {
    id: "CND-002",
    parentName: "امیر حسینی",
    requestId: null,
    type: "purchase",
    amount: "+۱۰۰ 🍬",
    balancePlaceholder: "۱۰۰ 🍬",
    status: "completed",
    createdAt: "۸ دی ۱۴۰۴",
    note: "خرید بسته آبنبات از طریق درگاه پرداخت",
  },
  {
    id: "CND-003",
    parentName: "الناز کریمی",
    requestId: "REQ-005",
    type: "request_charge",
    amount: "-۵۰ 🍬",
    balancePlaceholder: "۹۰ 🍬",
    status: "completed",
    createdAt: "۱۵ دی ۱۴۰۴",
    note: "مصرف برای درخواست داستان شب با پری نیلا",
  },
  {
    id: "CND-004",
    parentName: "فاطمه سعیدی",
    requestId: "REQ-007",
    type: "request_charge",
    amount: "-۲۰ 🍬",
    balancePlaceholder: "۱۳۰ 🍬",
    status: "pending",
    createdAt: "۱۱ دی ۱۴۰۴",
    note: "مصرف در انتظار تأیید نهایی درخواست",
  },
  {
    id: "CND-005",
    parentName: "مریم احمدی",
    requestId: null,
    type: "bonus",
    amount: "+۵۰ 🍬",
    balancePlaceholder: "۱۷۵ 🍬",
    status: "completed",
    createdAt: "۱۰ دی ۱۴۰۴",
    note: "اعتبار هدیه به مناسبت ثبت‌نام",
  },
  {
    id: "CND-006",
    parentName: "سعید رضایی",
    requestId: "REQ-002",
    type: "admin_adjustment",
    amount: "-۱۵ 🍬",
    balancePlaceholder: "۶۰ 🍬",
    status: "completed",
    createdAt: "۱۲ دی ۱۴۰۴",
    note: "اصلاح دستی توسط ادمین — هزینه اضافه ویدیو",
  },
  {
    id: "CND-007",
    parentName: "رضا نوری",
    requestId: null,
    type: "refund_placeholder",
    amount: "+۴۰ 🍬",
    balancePlaceholder: "۴۰ 🍬",
    status: "placeholder",
    createdAt: "۱۶ دی ۱۴۰۴",
    note: "نمونه بازگشت اعتبار — منطق بازپرداخت هنوز پیاده‌سازی نشده",
  },
  {
    id: "CND-008",
    parentName: "زهرا محمدی",
    requestId: "REQ-003",
    type: "request_charge",
    amount: "-۲۵ 🍬",
    balancePlaceholder: "۸۵ 🍬",
    status: "completed",
    createdAt: "۱۰ دی ۱۴۰۴",
    note: "مصرف برای جان‌بخشی به نقاشی اسب",
  },
  {
    id: "CND-009",
    parentName: "محمد اکبری",
    requestId: null,
    type: "purchase",
    amount: "+۵۰ 🍬",
    balancePlaceholder: "۵۰ 🍬",
    status: "pending",
    createdAt: "۱۷ دی ۱۴۰۴",
    note: "خرید در انتظار تأیید پرداخت",
  },
  {
    id: "CND-010",
    parentName: "فاطمه سعیدی",
    requestId: "REQ-007",
    type: "admin_adjustment",
    amount: "-۱۰ 🍬",
    balancePlaceholder: "۱۲۰ 🍬",
    status: "cancelled",
    createdAt: "۱۱ دی ۱۴۰۴",
    note: "اصلاح ادمین لغو شد — اعتبار برگردانده می‌شود",
  },
];

export default function AdminCandyLedgerPage() {
  return (
    <div>
      <PageHeader
        title="گردش آبنبات‌ها"
        description="نمایش نمونه‌ای از تراکنش‌های داخلی آبنبات‌ها برای درخواست‌ها، مصرف اعتبار و اصلاحات ادمین."
      />
      <Card variant="admin" className="mb-8 border-mint-green/20 bg-mint-green/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">🍬</span>
          <div>
            <h3 className="font-semibold text-parent-navy">یادآوری مهم</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              این بخش در حال حاضر فقط نمایشی است. آبنبات‌ها اعتبار داخلی کارتونا هستند و
              اتصال پرداخت، بازپرداخت یا محاسبه واقعی موجودی هنوز پیاده‌سازی نشده است.
            </p>
          </div>
        </div>
      </Card>
      <div className="grid gap-4">
        {transactions.map((tx) => (
          <Card key={tx.id} variant="admin">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-parent-navy">{tx.id}</span>
                <Badge variant={statusVariants[tx.status]}>{statusLabels[tx.status]}</Badge>
              </div>
              <Badge variant={typeVariants[tx.type]}>{typeLabels[tx.type]}</Badge>
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs text-text-dark/50">
              <div className="flex justify-between">
                <span>والد</span>
                <span className="text-text-dark/70">{tx.parentName}</span>
              </div>
              <div className="flex justify-between">
                <span>درخواست</span>
                <span className="text-text-dark/70">{tx.requestId ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span>مقدار</span>
                <span className="text-text-dark/70 font-medium">{tx.amount}</span>
              </div>
              <div className="flex justify-between">
                <span>موجودی پس از تراکنش</span>
                <span className="text-text-dark/70 font-medium">{tx.balancePlaceholder}</span>
              </div>
              <div className="flex justify-between">
                <span>تاریخ</span>
                <span className="text-text-dark/70">{tx.createdAt}</span>
              </div>
            </div>
            <div className="mt-3 border-t border-soft-border pt-2 text-xs text-text-dark/40">
              {tx.note}
            </div>
            <div className="mt-3">
              <Button variant="secondary" size="sm" disabled>
                مشاهده جزئیات تراکنش
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

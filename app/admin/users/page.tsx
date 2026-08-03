import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const roleLabels: Record<string, string> = {
  parent: "والد",
  admin: "ادمین",
};

const statusLabels: Record<string, string> = {
  active: "فعال",
  pending_review: "نیازمند بررسی",
  restricted: "محدود شده",
  inactive: "غیرفعال",
};

const statusVariants: Record<string, "success" | "warning" | "danger" | "default"> = {
  active: "success",
  pending_review: "warning",
  restricted: "danger",
  inactive: "default",
};

interface MockUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  childProfiles: number;
  requestCount: number;
  lastActivity: string;
  adminNote: string;
}

const users: MockUser[] = [
  {
    id: "USR-001",
    name: "مریم احمدی",
    email: "maryam.a@example.com",
    role: "parent",
    status: "active",
    childProfiles: 2,
    requestCount: 4,
    lastActivity: "۱۵ دی ۱۴۰۴",
    adminNote: "والد فعال با چند درخواست",
  },
  {
    id: "USR-002",
    name: "سعید رضایی",
    email: "saeed.r@example.com",
    role: "parent",
    status: "active",
    childProfiles: 1,
    requestCount: 2,
    lastActivity: "۱۲ دی ۱۴۰۴",
    adminNote: "درخواست ویدیو در حال انجام",
  },
  {
    id: "USR-003",
    name: "زهرا محمدی",
    email: "zahra.m@example.com",
    role: "parent",
    status: "active",
    childProfiles: 2,
    requestCount: 3,
    lastActivity: "۱۰ دی ۱۴۰۴",
    adminNote: "تحویل نقاشی انجام شده",
  },
  {
    id: "USR-004",
    name: "امیر حسینی",
    email: "amir.h@example.com",
    role: "parent",
    status: "pending_review",
    childProfiles: 1,
    requestCount: 1,
    lastActivity: "۸ دی ۱۴۰۴",
    adminNote: "رضایت والد نیازمند بررسی مجدد",
  },
  {
    id: "USR-005",
    name: "الناز کریمی",
    email: "elnaz.k@example.com",
    role: "parent",
    status: "active",
    childProfiles: 1,
    requestCount: 2,
    lastActivity: "۱۵ دی ۱۴۰۴",
    adminNote: "درخواست جدید ثبت شده",
  },
  {
    id: "USR-006",
    name: "رضا نوری",
    email: "reza.n@example.com",
    role: "parent",
    status: "restricted",
    childProfiles: 1,
    requestCount: 0,
    lastActivity: "۱ دی ۱۴۰۴",
    adminNote: "محدودیت موقت به دلیل تأیید نشدن رضایت",
  },
  {
    id: "USR-007",
    name: "فاطمه سعیدی",
    email: "fatemeh.s@example.com",
    role: "parent",
    status: "active",
    childProfiles: 2,
    requestCount: 5,
    lastActivity: "۱۱ دی ۱۴۰۴",
    adminNote: "والد پرکار با درخواست‌های متنوع",
  },
  {
    id: "USR-008",
    name: "محمد اکبری",
    email: "mohammad.a@example.com",
    role: "parent",
    status: "inactive",
    childProfiles: 1,
    requestCount: 0,
    lastActivity: "۲۰ آذر ۱۴۰۴",
    adminNote: "ثبت‌نام کرده اما درخواستی ثبت نکرده",
  },
];

export default function AdminUsersPage() {
  return (
    <div>
      <PageHeader
        title="کاربران"
        description="نمایش حساب‌های والدین، وضعیت دسترسی و خلاصه فعالیت‌های مرتبط با درخواست‌های کارتونا."
      />
      <Card variant="admin" className="mb-8 border-sunshine-yellow/20 bg-sunshine-yellow/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">👤</span>
          <div>
            <h3 className="font-semibold text-parent-navy">اصل مهم حساب کاربری</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              در کارتونا حساب کاربری متعلق به والدین است. کودک حساب مستقل، ورود جداگانه
              یا پروفایل عمومی ندارد.
            </p>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {users.map((user) => (
          <Card key={user.id} variant="admin">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold text-parent-navy">{user.name}</h3>
                <span className="text-xs text-text-dark/40">{user.id}</span>
              </div>
              <Badge variant={statusVariants[user.status]}>{statusLabels[user.status]}</Badge>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="default">{roleLabels[user.role]}</Badge>
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs text-text-dark/50">
              <div className="flex justify-between">
                <span>ایمیل</span>
                <span className="text-text-dark/70" dir="ltr">{user.email}</span>
              </div>
              <div className="flex justify-between">
                <span>پروفایل کودک</span>
                <span className="text-text-dark/70">{user.childProfiles} نفر</span>
              </div>
              <div className="flex justify-between">
                <span>درخواست‌ها</span>
                <span className="text-text-dark/70">{user.requestCount} مورد</span>
              </div>
              <div className="flex justify-between">
                <span>آخرین فعالیت</span>
                <span className="text-text-dark/70">{user.lastActivity}</span>
              </div>
            </div>
            <div className="mt-3 border-t border-soft-border pt-2 text-xs text-text-dark/40">
              {user.adminNote}
            </div>
            <div className="mt-3">
              <Button variant="secondary" size="sm" disabled>
                مدیریت دسترسی
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

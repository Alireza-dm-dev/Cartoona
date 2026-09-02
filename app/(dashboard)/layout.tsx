import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full bg-cream">
      <header className="border-b border-soft-border bg-white">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-3">
          <Link href="/dashboard" className="text-lg font-bold text-candy-pink">
            پنل والدین کارتونا
          </Link>
          <nav className="hidden items-center gap-5 text-sm font-medium text-text-dark/70 sm:flex">
            <Link href="/dashboard">داشبورد</Link>
            <Link href="/dashboard/create-image">ساخت تصویر کارتونی</Link>
            <Link href="/dashboard/orders">درخواست‌ها</Link>
            <Link href="/dashboard/gallery">گالری خصوصی</Link>
            <Link href="/dashboard/billing">آبنبات‌ها و پرداخت</Link>
            <Link href="/dashboard/referrals">معرفی دوستان</Link>
            <Link href="/dashboard/settings">تنظیمات</Link>
          </nav>
          <div className="ml-auto hidden sm:block">
            <form action="/api/logout" method="post">
              <button
                type="submit"
                className="rounded-lg bg-soft-border/30 px-4 py-2 text-sm font-medium text-text-dark hover:bg-soft-border/50"
              >
                خروج
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-[1280px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}

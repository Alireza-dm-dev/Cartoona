import Link from "next/link";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full">
      <header className="border-b border-soft-border bg-white">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-bold text-candy-pink">
            کارتونا
          </Link>
          <nav className="hidden items-center gap-6 text-sm font-medium text-text-dark sm:flex">
            <Link href="/characters">شخصیت‌ها</Link>
            <Link href="/examples">نمونه‌ها</Link>
            <Link href="/pricing">قیمت‌گذاری</Link>
            <Link href="/safety">ایمنی و حریم خصوصی</Link>
            <Link href="/faq">سوالات متداول</Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-full px-4 py-2 text-sm font-medium text-parent-navy hover:bg-soft-border/50 transition-colors"
            >
              ورود
            </Link>
            <Link
              href="/signup"
              className="rounded-full bg-candy-pink px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
            >
              شروع کنید
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-soft-border bg-white">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-4 px-6 py-8 text-sm text-text-dark/60 sm:flex-row sm:justify-between">
          <p>&copy; {new Date().getFullYear()} کارتونا. کلیه حقوق محفوظ است.</p>
          <div className="flex gap-4">
            <Link href="/safety">حریم خصوصی</Link>
            <Link href="/faq">سوالات متداول</Link>
            <Link href="/safety">ایمنی و حریم خصوصی</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

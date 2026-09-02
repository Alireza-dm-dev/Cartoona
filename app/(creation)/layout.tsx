import Link from "next/link";

export default function CreationLayout({
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
              ساخت حساب
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1 bg-cream">
        <div className="mx-auto max-w-[880px] px-6 py-8">
          {children}
        </div>
      </main>
      <footer className="border-t border-soft-border bg-white">
        <div className="mx-auto max-w-[1200px] px-6 py-6 text-center text-xs text-text-dark/50">
          تمام اطلاعات و درخواست‌های شما در کارتونا خصوصی و تحت کنترل والدین است.
        </div>
      </footer>
    </div>
  );
}

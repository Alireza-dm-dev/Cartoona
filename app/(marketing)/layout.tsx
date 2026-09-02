import Link from "next/link";
import { SiteHeader } from "@/components/layout/SiteHeader";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full">
      <SiteHeader />
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

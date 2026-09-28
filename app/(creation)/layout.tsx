import Link from "next/link";
import { ParentAccountDrawer } from "@/components/layout/parent-account-drawer";
import { getPublicHeaderAccount } from "@/lib/auth/public-header-account";
import { AppBackground } from "@/components/ui/app-background";

/**
 * Reading the session cookie here opts the creation routes out of static
 * rendering, so a signed-in parent keeps their account control while creating.
 * The anonymous entry points are unchanged: deferred auth still works exactly
 * as before for a visitor who has not signed in.
 */
export default async function CreationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const account = await getPublicHeaderAccount();

  return (
    <div className="relative flex flex-col min-h-full">
      <AppBackground />
      <header className="relative z-10 neu-raised m-3 rounded-2xl sm:m-4">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-bold text-candy-pink">
            کارتونا
          </Link>
          <div className="flex items-center gap-3">
            {account ? (
              <ParentAccountDrawer account={account} />
            ) : (
              <>
                <Link
                  href="/login"
                  className="neu-interactive rounded-full px-4 py-2 text-sm font-medium text-parent-navy"
                >
                  ورود
                </Link>
                <Link
                  href="/signup"
                  className="neu-cta neu-interactive rounded-full px-4 py-2 text-sm font-medium text-white"
                >
                  ساخت حساب
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="relative z-10 flex-1">
        <div className="mx-auto max-w-[880px] px-6 py-8">
          {children}
        </div>
      </main>
      <footer className="relative z-10 mx-3 mb-3 neu-raised rounded-2xl sm:mx-4 sm:mb-4">
        <div className="mx-auto max-w-[1200px] px-6 py-6 text-center text-xs text-text-dark/50">
          تمام اطلاعات و درخواست‌های شما در کارتونا خصوصی و تحت کنترل والدین است.
        </div>
      </footer>
    </div>
  );
}

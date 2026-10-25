import Link from "next/link";
import { ParentPortalNav } from "@/components/dashboard/parent-portal-nav";
import {
  PARENT_PORTAL_BRAND_HREF,
  PARENT_PORTAL_BRAND_LABEL,
} from "@/lib/parent/navigation/parent-nav";
import { AppBackground } from "@/components/ui/app-background";
import { gateParentPage } from "@/lib/auth/page-gates";

function LogoutButton({ className }: { className?: string }) {
  return (
    <form action="/api/logout" method="post" className={className}>
      <button
        type="submit"
        className="neu-interactive min-h-[44px] w-full rounded-lg bg-coral/15 px-4 text-sm font-medium text-rose-800"
      >
        خروج
      </button>
    </form>
  );
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Authoritative role + session gate (V0.1.53, was the Edge middleware's
  // Supabase `users.role` read): PostgreSQL role through the backend. Nothing
  // under /dashboard renders for a signed-out, expired, unlinked or non-parent
  // caller; an admin is let through exactly as before.
  const gate = await gateParentPage("/dashboard");
  if (!gate.ok) {
    return (
      <div role="alert" className="mx-auto max-w-[560px] py-12 text-center">
        <p className="mb-4 text-text-dark/80">
          بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.
        </p>
        <a href="/dashboard" className="font-semibold text-candy-pink">تلاش دوباره</a>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col min-h-full">
      <AppBackground />
      {/* `relative` anchors the mobile navigation panel to the header. */}
      <header className="relative z-10 neu-raised m-3 rounded-2xl sm:m-4">
        <div className="mx-auto flex max-w-[1280px] items-center gap-4 px-6 py-3">
          {/* Leaving the portal must not end the session: this is an ordinary
              link to the public site, not a logout. */}
          <Link
            href={PARENT_PORTAL_BRAND_HREF}
            className="text-lg font-bold text-candy-pink"
          >
            {PARENT_PORTAL_BRAND_LABEL}
          </Link>

          <div className="ms-auto flex items-center gap-4">
            <ParentPortalNav>
              <LogoutButton className="py-3" />
            </ParentPortalNav>
            <LogoutButton className="hidden w-auto sm:block" />
          </div>
        </div>
      </header>
      <main className="relative z-10 flex-1 mx-auto w-full max-w-[1280px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}

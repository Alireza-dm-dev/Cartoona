import Link from "next/link";
import { ParentPortalNav } from "@/components/dashboard/parent-portal-nav";
import {
  PARENT_PORTAL_BRAND_HREF,
  PARENT_PORTAL_BRAND_LABEL,
} from "@/lib/parent/navigation/parent-nav";

function LogoutButton({ className }: { className?: string }) {
  return (
    <form action="/api/logout" method="post" className={className}>
      <button
        type="submit"
        className="min-h-[44px] w-full rounded-lg bg-soft-border/30 px-4 text-sm font-medium text-text-dark hover:bg-soft-border/50"
      >
        خروج
      </button>
    </form>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full bg-cream">
      {/* `relative` anchors the mobile navigation panel to the header. */}
      <header className="relative border-b border-soft-border bg-white">
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
            <LogoutButton className="hidden sm:block" />
          </div>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-[1280px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}

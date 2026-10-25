import Link from "next/link"
import { gateAdminPage } from "@/lib/auth/page-gates"
import { ADMIN_BRAND_HREF, ADMIN_BRAND_LABEL, ADMIN_NAV_ITEMS } from "@/lib/admin/navigation/admin-nav"
import { AppBackground } from "@/components/ui/app-background"

// The admin shell resolves the session for every admin route, so nothing under
// /admin may be prerendered. Without this, `next build` would try to render the
// admin pages and fail on the missing Supabase configuration, making the build
// depend on a live backend (V0.1.35).
export const dynamic = "force-dynamic"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Authoritative role gate (V0.1.53): verified identity -> backend -> PostgreSQL
  // role. No Supabase table is read; the Edge middleware only checks that a
  // session exists.
  const gate = await gateAdminPage("/admin")
  if (!gate.ok) {
    return (
      <div role="alert" className="mx-auto max-w-[560px] py-12 text-center">
        <p className="mb-4 text-text-dark/80">بررسی دسترسی موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.</p>
        <a href="/admin" className="font-semibold text-candy-pink">تلاش دوباره</a>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-full">
      <AppBackground />
      <aside className="relative z-10 hidden w-60 shrink-0 lg:block p-3">
        <div className="neu-raised sticky top-3 rounded-2xl p-3">
          <Link href={ADMIN_BRAND_HREF} className="mb-4 block px-2 text-lg font-bold text-parent-navy">
            {ADMIN_BRAND_LABEL}
          </Link>
          <nav className="flex flex-col gap-1 text-sm">
            {ADMIN_NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="neu-interactive rounded-lg px-3 py-2 transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </aside>
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="neu-raised m-3 mb-0 rounded-2xl px-6 py-3 lg:mx-4 lg:mt-4">
          <p className="text-sm text-text-dark/60">{ADMIN_BRAND_LABEL}</p>
        </header>
        <nav className="neu-raised mx-3 mt-3 flex gap-1 overflow-x-auto rounded-2xl px-2 py-2 text-sm lg:hidden">
          {ADMIN_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="neu-interactive shrink-0 rounded-lg px-3 py-2 transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 mx-auto w-full max-w-[1440px] px-6 py-6">
          {children}
        </main>
      </div>
    </div>
  )
}

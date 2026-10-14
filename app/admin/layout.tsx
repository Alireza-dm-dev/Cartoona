import Link from "next/link"
import { redirect } from "next/navigation"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isAdminRole } from "@/lib/auth/admin-role"
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
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/admin-login?from=/admin")
  }

  try {
    const { data: roleRow } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle()

    if (!roleRow || !isAdminRole(roleRow.role)) {
      redirect("/dashboard")
    }
  } catch {
    redirect("/dashboard")
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

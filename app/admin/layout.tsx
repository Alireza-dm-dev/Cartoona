import Link from "next/link"
import { redirect } from "next/navigation"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isAdminRole } from "@/lib/auth/admin-role"
import { ADMIN_BRAND_HREF, ADMIN_BRAND_LABEL, ADMIN_NAV_ITEMS } from "@/lib/admin/navigation/admin-nav"

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
    <div className="flex min-h-full bg-cream">
      <aside className="hidden w-64 shrink-0 border-l border-soft-border bg-white p-4 lg:block">
        <Link href={ADMIN_BRAND_HREF} className="mb-6 block text-lg font-bold text-parent-navy">
          {ADMIN_BRAND_LABEL}
        </Link>
        <nav className="flex flex-col gap-1 text-sm">
          {ADMIN_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 hover:bg-cream transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-soft-border bg-white px-6 py-3">
          <p className="text-sm text-text-dark/60">{ADMIN_BRAND_LABEL}</p>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-soft-border bg-white px-3 py-2 text-sm lg:hidden">
          {ADMIN_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 mx-auto w-full max-w-[1440px] px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  )
}

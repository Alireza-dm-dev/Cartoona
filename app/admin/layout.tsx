import Link from "next/link"
import { redirect } from "next/navigation"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isAdminRole } from "@/lib/auth/admin-role"

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
        <Link href="/admin" className="mb-6 block text-lg font-bold text-parent-navy">
          پنل مدیریت کارتونا
        </Link>
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/admin" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">داشبورد</Link>
          <Link href="/admin/requests" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">درخواست‌ها</Link>
          <Link href="/admin/media" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">رسانه‌ها</Link>
          <Link href="/admin/examples" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">نمونه‌ها</Link>
          <Link href="/admin/users" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">کاربران</Link>
          <Link href="/admin/characters" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">شخصیت‌ها</Link>
          <Link href="/admin/referrals" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">مدیریت معرفی</Link>
          <Link href="/admin/coupons" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">کدهای تخفیف</Link>
          <Link href="/admin/candy-ledger" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">گردش آبنبات‌ها</Link>
          <Link href="/admin/moderation" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">بررسی ایمنی</Link>
          <Link href="/admin/settings" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">تنظیمات</Link>
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-soft-border bg-white px-6 py-3">
          <p className="text-sm text-text-dark/60">پنل مدیریت کارتونا</p>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-soft-border bg-white px-3 py-2 text-sm lg:hidden">
          <Link href="/admin" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">داشبورد</Link>
          <Link href="/admin/requests" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">درخواست‌ها</Link>
          <Link href="/admin/media" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">رسانه‌ها</Link>
          <Link href="/admin/examples" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">نمونه‌ها</Link>
          <Link href="/admin/users" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">کاربران</Link>
          <Link href="/admin/characters" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">شخصیت‌ها</Link>
          <Link href="/admin/referrals" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">مدیریت معرفی</Link>
          <Link href="/admin/coupons" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">کدهای تخفیف</Link>
          <Link href="/admin/candy-ledger" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">گردش آبنبات‌ها</Link>
          <Link href="/admin/moderation" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">بررسی ایمنی</Link>
          <Link href="/admin/settings" className="shrink-0 rounded-lg px-3 py-2 hover:bg-cream transition-colors">تنظیمات</Link>
        </nav>
        <main className="flex-1 mx-auto w-full max-w-[1440px] px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  )
}

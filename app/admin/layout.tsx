import Link from "next/link";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full bg-cream">
      <aside className="hidden w-64 shrink-0 border-r border-soft-border bg-white p-4 lg:block">
        <Link href="/admin" className="mb-6 block text-lg font-bold text-parent-navy">
          Cartoona Admin
        </Link>
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/admin" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Dashboard</Link>
          <Link href="/admin/requests" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Requests</Link>
          <Link href="/admin/media" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Media</Link>
          <Link href="/admin/users" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Users</Link>
          <Link href="/admin/characters" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Characters</Link>
          <Link href="/admin/candy-ledger" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Candy Ledger</Link>
          <Link href="/admin/moderation" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Moderation</Link>
          <Link href="/admin/settings" className="rounded-lg px-3 py-2 hover:bg-cream transition-colors">Settings</Link>
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-soft-border bg-white px-6 py-3">
          <p className="text-sm text-text-dark/60">Admin Console</p>
        </header>
        <main className="flex-1 mx-auto w-full max-w-[1440px] px-6 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-full bg-cream">
      <header className="border-b border-soft-border bg-white">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-3">
          <Link href="/dashboard" className="text-lg font-bold text-candy-pink">
            Cartoona
          </Link>
          <nav className="hidden items-center gap-5 text-sm font-medium text-text-dark/70 sm:flex">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/dashboard/create-image">Create</Link>
            <Link href="/dashboard/orders">Orders</Link>
            <Link href="/dashboard/gallery">Gallery</Link>
            <Link href="/dashboard/billing">Billing</Link>
            <Link href="/dashboard/settings">Settings</Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-[1280px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}

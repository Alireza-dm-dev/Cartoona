import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

const stats = [
  { label: "Pending Requests", value: "—" },
  { label: "Active Users", value: "—" },
  { label: "Media Assets", value: "—" },
  { label: "Candies Issued", value: "—" },
];

export default function AdminDashboardPage() {
  return (
    <div>
      <PageHeader
        title="Admin Dashboard"
        description="Production overview and quick actions."
      />
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} variant="admin">
            <p className="text-sm text-text-dark/60">{stat.label}</p>
            <p className="mt-1 text-2xl font-bold text-parent-navy">{stat.value}</p>
          </Card>
        ))}
      </div>
      <p className="text-xs text-text-dark/30">
        TODO: Add real stats from Supabase. Add role guard — super_admin/admin only.
      </p>
    </div>
  );
}

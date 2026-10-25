import Link from "next/link"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/neu-button"
import { EmptyState } from "@/components/ui/empty-state"
import { ExampleList } from "@/components/admin/examples/example-list"
import { loadAdminExamples } from "@/lib/examples/backend-examples"

// Per-request, auth-gated page: it reads the session on every request and must
// never be prerendered. Without this, `next build` would try to render it and
// fail on the missing Supabase configuration, making the build depend on a
// live backend (V0.1.35).
export const dynamic = "force-dynamic";

export default async function AdminExamplesPage() {
  // PostgreSQL through the backend (V0.1.53); the admin gate is the layout's and the backend's.
  const examples = await loadAdminExamples()
  const error = examples === null

  return (
    <div>
      <PageHeader
        title="مدیریت نمونه‌ها"
        description="نمونه‌های نمایشی صفحه عمومی کارتونا را اضافه، ویرایش، منتشر یا حذف کنید."
        action={
          <Link href="/admin/examples/new">
            <Button variant="primary">افزودن نمونه</Button>
          </Link>
        }
      />

      {error ? (
        <Card variant="admin" className="border-coral/20 bg-coral/5">
          <p className="text-sm text-coral">
            دریافت اطلاعات با خطا مواجه شد. لطفاً دوباره تلاش کنید.
          </p>
          <div className="mt-4">
            <Link href="/admin/examples/new">
              <Button variant="primary">افزودن نمونه</Button>
            </Link>
          </div>
        </Card>
      ) : examples!.length === 0 ? (
        <EmptyState
          title="هنوز نمونه‌ای اضافه نشده است"
          description="اولین نمونه نمایشی را برای صفحه عمومی کارتونا اضافه کنید."
          action={
            <Link href="/admin/examples/new">
              <Button variant="primary">افزودن نمونه</Button>
            </Link>
          }
        />
      ) : (
        <ExampleList initialExamples={examples!} />
      )}
    </div>
  )
}

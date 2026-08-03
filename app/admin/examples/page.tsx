import Link from "next/link"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ExampleList } from "@/components/admin/examples/example-list"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export default async function AdminExamplesPage() {
  const supabase = await createServerSupabaseClient()

  const { data: examples, error } = await supabase
    .from("examples")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })

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
      ) : examples.length === 0 ? (
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
        <ExampleList initialExamples={examples} />
      )}
    </div>
  )
}

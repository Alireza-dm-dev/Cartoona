import { PageHeader } from "@/components/ui/page-header"
import { ExampleForm } from "@/components/admin/examples/example-form"

export default function NewExamplePage() {
  return (
    <div>
      <PageHeader
        title="افزودن نمونه"
        description="اطلاعات و تصویر نمونه جدید را وارد کنید."
      />
      <ExampleForm mode="create" />
    </div>
  )
}

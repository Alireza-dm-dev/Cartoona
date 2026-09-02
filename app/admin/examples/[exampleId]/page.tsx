import { notFound } from "next/navigation"
import { PageHeader } from "@/components/ui/page-header"
import { ExampleForm } from "@/components/admin/examples/example-form"
import { createServerSupabaseClient } from "@/lib/supabase/server"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function EditExamplePage({
  params,
}: {
  params: Promise<{ exampleId: string }>
}) {
  const { exampleId } = await params

  if (!UUID_REGEX.test(exampleId)) {
    notFound()
  }

  const supabase = await createServerSupabaseClient()

  const { data: example, error } = await supabase
    .from("examples")
    .select("*")
    .eq("id", exampleId)
    .maybeSingle()

  if (error || !example) {
    notFound()
  }

  return (
    <div>
      <PageHeader
        title="ویرایش نمونه"
        description="اطلاعات، وضعیت انتشار یا تصویر نمونه را تغییر دهید."
      />
      <ExampleForm mode="edit" initialExample={example} />
    </div>
  )
}

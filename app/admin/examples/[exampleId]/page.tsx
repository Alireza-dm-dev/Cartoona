import { notFound } from "next/navigation"
import { PageHeader } from "@/components/ui/page-header"
import { ExampleForm } from "@/components/admin/examples/example-form"
import { loadAdminExample } from "@/lib/examples/backend-examples"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Per-request, auth-gated page: it reads the session on every request and must
// never be prerendered. Without this, `next build` would try to render it and
// fail on the missing Supabase configuration, making the build depend on a
// live backend (V0.1.35).
export const dynamic = "force-dynamic";

export default async function EditExamplePage({
  params,
}: {
  params: Promise<{ exampleId: string }>
}) {
  const { exampleId } = await params

  if (!UUID_REGEX.test(exampleId)) {
    notFound()
  }

  const example = await loadAdminExample(exampleId)

  if (example === "missing" || example === null) {
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

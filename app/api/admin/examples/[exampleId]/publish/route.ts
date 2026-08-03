import { NextResponse } from "next/server"
import { requireExamplesAdmin, AdminAuthError } from "@/lib/examples/example-auth"
import { validateExampleId, validatePublishInput } from "@/lib/examples/example-validation"

async function fetchExample(supabase: Awaited<ReturnType<typeof requireExamplesAdmin>>["supabase"], id: string) {
  const { data, error } = await supabase
    .from("examples")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) {
    return { error: "Failed to fetch example" as const, status: 500 }
  }

  if (!data) {
    return { error: "Example not found" as const, status: 404 }
  }

  return { data }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ exampleId: string }> },
) {
  try {
    const { supabase } = await requireExamplesAdmin()
    const { exampleId } = await params

    const idError = validateExampleId(exampleId)
    if (idError) {
      return NextResponse.json({ error: idError }, { status: 400 })
    }

    const exists = await fetchExample(supabase, exampleId)
    if ("error" in exists) {
      return NextResponse.json({ error: exists.error }, { status: exists.status })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const { data: input, errors } = validatePublishInput(body)
    if (errors.length > 0) {
      return NextResponse.json({ error: "Validation failed", errors }, { status: 422 })
    }

    const { data: updated, error: updateError } = await supabase
      .from("examples")
      .update({ is_published: input!.is_published })
      .eq("id", exampleId)
      .select()
      .maybeSingle()

    if (updateError || !updated) {
      return NextResponse.json({ error: "Failed to update publish status" }, { status: 500 })
    }

    return NextResponse.json({ data: updated })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

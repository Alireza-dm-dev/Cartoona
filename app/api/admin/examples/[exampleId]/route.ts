import { NextResponse } from "next/server"
import { requireExamplesAdmin, AdminAuthError } from "@/lib/examples/example-auth"
import { validateExampleId, validateUpdateExampleJson } from "@/lib/examples/example-validation"
import { deleteImage } from "@/lib/examples/example-storage"

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exampleId: string }> },
) {
  try {
    const { supabase } = await requireExamplesAdmin()
    const { exampleId } = await params

    const idError = validateExampleId(exampleId)
    if (idError) {
      return NextResponse.json({ error: idError }, { status: 400 })
    }

    const result = await fetchExample(supabase, exampleId)
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ data: result.data })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
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

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const { data: input, errors } = validateUpdateExampleJson(body)
    if (errors.length > 0) {
      return NextResponse.json({ error: "Validation failed", errors }, { status: 422 })
    }

    if (!input || Object.keys(input).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
    }

    const { data: updated, error: updateError } = await supabase
      .from("examples")
      .update(input)
      .eq("id", exampleId)
      .select()
      .maybeSingle()

    if (updateError || !updated) {
      return NextResponse.json({ error: "Failed to update example" }, { status: 500 })
    }

    return NextResponse.json({ data: updated })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ exampleId: string }> },
) {
  try {
    const { supabase } = await requireExamplesAdmin()
    const { exampleId } = await params

    const idError = validateExampleId(exampleId)
    if (idError) {
      return NextResponse.json({ error: idError }, { status: 400 })
    }

    const existing = await fetchExample(supabase, exampleId)
    if ("error" in existing) {
      return NextResponse.json({ error: existing.error }, { status: existing.status })
    }

    const { error: deleteError } = await supabase
      .from("examples")
      .delete()
      .eq("id", exampleId)

    if (deleteError) {
      return NextResponse.json({ error: "Failed to delete example" }, { status: 500 })
    }

    if (existing.data.media_url) {
      try {
        await deleteImage(supabase, existing.data.media_url)
      } catch {
        // Row already deleted — storage cleanup failure does not revert it.
      }
    }

    return NextResponse.json({ data: existing.data })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

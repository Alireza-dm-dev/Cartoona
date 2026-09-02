import { NextResponse } from "next/server"
import { requireExamplesAdmin, AdminAuthError } from "@/lib/examples/example-auth"
import { validateExampleId } from "@/lib/examples/example-validation"
import { validateImageFile, buildStoragePath, uploadImage, deleteImage } from "@/lib/examples/example-storage"

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

export async function PUT(
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

    const existing = await fetchExample(supabase, exampleId)
    if ("error" in existing) {
      return NextResponse.json({ error: existing.error }, { status: existing.status })
    }

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
    }

    const imageFile = formData.get("image")
    if (!imageFile || !(imageFile instanceof File)) {
      return NextResponse.json(
        { error: "Validation failed", errors: [{ field: "image", message: "Image file is required" }] },
        { status: 422 },
      )
    }

    const imageError = validateImageFile(imageFile)
    if (imageError) {
      return NextResponse.json(
        { error: "Validation failed", errors: [{ field: "image", message: imageError }] },
        { status: 422 },
      )
    }

    const newStoragePath = buildStoragePath(exampleId, imageFile)

    try {
      await uploadImage(supabase, newStoragePath, imageFile)
    } catch {
      return NextResponse.json({ error: "Failed to upload image" }, { status: 500 })
    }

    const { data: updated, error: updateError } = await supabase
      .from("examples")
      .update({ media_url: newStoragePath })
      .eq("id", exampleId)
      .select()
      .maybeSingle()

    if (updateError || !updated) {
      await deleteImage(supabase, newStoragePath).catch(() => {})
      return NextResponse.json({ error: "Failed to update example" }, { status: 500 })
    }

    if (existing.data.media_url) {
      try {
        await deleteImage(supabase, existing.data.media_url)
      } catch {
        // Row updated successfully — old image deletion failure is non-fatal.
      }
    }

    return NextResponse.json({ data: updated })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

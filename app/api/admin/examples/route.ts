import { NextResponse } from "next/server"
import { requireExamplesAdmin, AdminAuthError } from "@/lib/examples/example-auth"
import { validateCreateExampleForm } from "@/lib/examples/example-validation"
import { validateImageFile, buildStoragePath, uploadImage, deleteImage } from "@/lib/examples/example-storage"

export async function GET() {
  try {
    const { supabase } = await requireExamplesAdmin()

    const { data, error } = await supabase
      .from("examples")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false })

    if (error) {
      return NextResponse.json({ error: "Failed to fetch examples" }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireExamplesAdmin()

    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
    }

    const { data: input, errors } = validateCreateExampleForm(formData)
    if (errors.length > 0) {
      return NextResponse.json({ error: "Validation failed", errors }, { status: 422 })
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

    const exampleId = crypto.randomUUID()
    const storagePath = buildStoragePath(exampleId, imageFile)

    await uploadImage(supabase, storagePath, imageFile)

    const { data: created, error: insertError } = await supabase
      .from("examples")
      .insert({
        id: exampleId,
        kind: input!.kind,
        title: input!.title,
        badge_label: input!.badge_label,
        description: input!.description,
        media_url: storagePath,
        is_published: input!.is_published,
        sort_order: input!.sort_order,
      })
      .select()
      .maybeSingle()

    if (insertError || !created) {
      await deleteImage(supabase, storagePath).catch(() => {})
      return NextResponse.json({ error: "Failed to create example" }, { status: 500 })
    }

    return NextResponse.json({ data: created }, { status: 201 })
  } catch (e) {
    if (e instanceof AdminAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

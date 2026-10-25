import { NextResponse } from "next/server"
import { verifiedCaller } from "@/lib/http/backend-route-responses"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { validateCreateExampleForm } from "@/lib/examples/example-validation"
import { validateImageFile, buildStoragePath } from "@/lib/examples/example-storage"
import { removeExampleImage, uploadExampleImage } from "@/lib/storage/example-media"
import {
  createExampleRow,
  exampleAdminGate,
  exampleFailureResponse,
  exampleOf,
  adminExamplesResult,
} from "@/lib/examples/backend-examples"

export const dynamic = "force-dynamic"

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

/**
 * Examples CMS (V0.1.53): metadata in PostgreSQL through the backend, image bytes
 * in Storage. The admin decision is the backend's (403 for a parent), asked
 * BEFORE a byte is stored; the browser supplies the form and nothing else.
 */
export async function GET() {
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const result = await adminExamplesResult(caller.context)
  if (!result.ok) return exampleFailureResponse(result, json)
  return json({ data: result.data }, 200)
}

export async function POST(request: Request) {
  const csrf = rejectUnsafeBrowserWrite(request, process.env, "multipart")
  if (csrf) return csrf

  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response

  // Admin gate (PostgreSQL role, through the backend) before the body is read or a byte stored.
  const gate = await exampleAdminGate(caller.context)
  if (!gate.ok) return exampleFailureResponse(gate as Exclude<typeof gate, { ok: true }>, json)

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return json({ error: "Invalid form data" }, 400)
  }

  const { data: input, errors } = validateCreateExampleForm(formData)
  if (errors.length > 0) return json({ error: "Validation failed", errors }, 422)

  const imageFile = formData.get("image")
  if (!imageFile || !(imageFile instanceof File)) {
    return json({ error: "Validation failed", errors: [{ field: "image", message: "Image file is required" }] }, 422)
  }
  const imageError = validateImageFile(imageFile)
  if (imageError) return json({ error: "Validation failed", errors: [{ field: "image", message: imageError }] }, 422)

  const exampleId = crypto.randomUUID()
  const storagePath = buildStoragePath(exampleId, imageFile)
  if (!(await uploadExampleImage(storagePath, imageFile))) return json({ error: "Failed to upload image" }, 500)

  const created = await createExampleRow(caller.context, {
    id: exampleId,
    kind: input!.kind,
    title: input!.title,
    badge_label: input!.badge_label,
    description: input!.description,
    media_url: storagePath,
    is_published: input!.is_published,
    sort_order: input!.sort_order,
  })
  const example = exampleOf(created)
  if (!created.ok || !example) {
    // A definite refusal removes the orphan object; an uncertain outcome keeps it (the row may exist).
    if (!created.ok && !(created.kind === "unavailable" && created.outcomeUnknown)) await removeExampleImage(storagePath)
    if (!created.ok) return exampleFailureResponse(created, json)
    return json({ error: "Failed to create example" }, 500)
  }
  return json({ data: example }, 201)
}

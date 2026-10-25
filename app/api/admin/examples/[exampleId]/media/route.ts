import { NextResponse } from "next/server"
import { verifiedCaller } from "@/lib/http/backend-route-responses"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { validateExampleId } from "@/lib/examples/example-validation"
import { validateImageFile, buildStoragePath } from "@/lib/examples/example-storage"
import { removeExampleImage, uploadExampleImage } from "@/lib/storage/example-media"
import { exampleAdminGate, exampleFailureResponse, exampleOf, loadAdminExample, replaceExampleMediaRow } from "@/lib/examples/backend-examples"

export const dynamic = "force-dynamic"

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

export async function PUT(request: Request, { params }: { params: Promise<{ exampleId: string }> }) {
  const csrf = rejectUnsafeBrowserWrite(request, process.env, "multipart")
  if (csrf) return csrf
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const { exampleId } = await params
  const idError = validateExampleId(exampleId)
  if (idError) return json({ error: idError }, 400)

  // Admin gate + existence BEFORE any byte is stored.
  const gate = await exampleAdminGate(caller.context)
  if (!gate.ok) return exampleFailureResponse(gate as Exclude<typeof gate, { ok: true }>, json)
  const existing = await loadAdminExample(exampleId)
  if (existing === "missing") return json({ error: "Example not found" }, 404)
  if (existing === null) return json({ error: "Failed to fetch example" }, 500)

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return json({ error: "Invalid form data" }, 400)
  }
  const imageFile = formData.get("image")
  if (!imageFile || !(imageFile instanceof File)) {
    return json({ error: "Validation failed", errors: [{ field: "image", message: "Image file is required" }] }, 422)
  }
  const imageError = validateImageFile(imageFile)
  if (imageError) return json({ error: "Validation failed", errors: [{ field: "image", message: imageError }] }, 422)

  const newStoragePath = buildStoragePath(exampleId, imageFile)
  if (!(await uploadExampleImage(newStoragePath, imageFile))) return json({ error: "Failed to upload image" }, 500)

  const result = await replaceExampleMediaRow(caller.context, exampleId, newStoragePath)
  if (!result.ok) {
    if (!(result.kind === "unavailable" && result.outcomeUnknown)) await removeExampleImage(newStoragePath)
    return exampleFailureResponse(result, json)
  }
  const example = exampleOf(result)
  const previous = typeof result.body.previousMediaUrl === "string" ? result.body.previousMediaUrl : null
  // Row updated - the old image's removal is best-effort.
  if (previous && previous !== newStoragePath) await removeExampleImage(previous)
  if (!example) return json({ error: "Failed to update example" }, 500)
  return json({ data: example }, 200)
}

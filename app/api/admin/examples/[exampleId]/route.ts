import { NextResponse } from "next/server"
import { verifiedCaller } from "@/lib/http/backend-route-responses"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { validateExampleId, validateUpdateExampleJson } from "@/lib/examples/example-validation"
import { removeExampleImage } from "@/lib/storage/example-media"
import {
  deleteExampleRow,
  exampleFailureResponse,
  exampleOf,
  loadAdminExample,
  updateExampleRow,
} from "@/lib/examples/backend-examples"

export const dynamic = "force-dynamic"

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

export async function GET(_request: Request, { params }: { params: Promise<{ exampleId: string }> }) {
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const { exampleId } = await params
  const idError = validateExampleId(exampleId)
  if (idError) return json({ error: idError }, 400)

  const example = await loadAdminExample(exampleId)
  if (example === "missing") return json({ error: "Example not found" }, 404)
  if (example === null) return json({ error: "Failed to fetch example" }, 500)
  return json({ data: example }, 200)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ exampleId: string }> }) {
  const csrf = rejectUnsafeBrowserWrite(request)
  if (csrf) return csrf
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const { exampleId } = await params
  const idError = validateExampleId(exampleId)
  if (idError) return json({ error: idError }, 400)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }
  const { data: input, errors } = validateUpdateExampleJson(body)
  if (errors.length > 0) return json({ error: "Validation failed", errors }, 422)
  if (!input || Object.keys(input).length === 0) return json({ error: "No valid fields to update" }, 400)

  const result = await updateExampleRow(caller.context, exampleId, input as Record<string, unknown>)
  const example = exampleOf(result)
  if (!result.ok) return exampleFailureResponse(result, json)
  if (!example) return json({ error: "Failed to update example" }, 500)
  return json({ data: example }, 200)
}

export async function DELETE(request: Request, { params }: { params: Promise<{ exampleId: string }> }) {
  const csrf = rejectUnsafeBrowserWrite(request)
  if (csrf) return csrf
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const { exampleId } = await params
  const idError = validateExampleId(exampleId)
  if (idError) return json({ error: idError }, 400)

  const result = await deleteExampleRow(caller.context, exampleId)
  if (!result.ok) return exampleFailureResponse(result, json)
  const example = exampleOf(result)
  // Row already deleted - a storage cleanup failure does not revert it.
  if (example?.media_url) await removeExampleImage(example.media_url)
  return json({ data: example }, 200)
}

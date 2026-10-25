import { NextResponse } from "next/server"
import { verifiedCaller } from "@/lib/http/backend-route-responses"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { validateExampleId, validatePublishInput } from "@/lib/examples/example-validation"
import { exampleFailureResponse, exampleOf, updateExampleRow } from "@/lib/examples/backend-examples"

export const dynamic = "force-dynamic"

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

export async function PATCH(request: Request, { params }: { params: Promise<{ exampleId: string }> }) {
  const csrf = rejectUnsafeBrowserWrite(request)
  if (csrf) return csrf
  const caller = await verifiedCaller()
  if (!caller.ok) return caller.response
  const { exampleId } = await params
  const idError = validateExampleId(exampleId)
  if (idError) return json({ error: idError }, 400)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }
  const { data: input, errors } = validatePublishInput(body)
  if (errors.length > 0) return json({ error: "Validation failed", errors }, 422)

  const result = await updateExampleRow(caller.context, exampleId, { is_published: input!.is_published })
  if (!result.ok) return exampleFailureResponse(result, json)
  const example = exampleOf(result)
  if (!example) return json({ error: "Failed to update publish status" }, 500)
  return json({ data: example }, 200)
}

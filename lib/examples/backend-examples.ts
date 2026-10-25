import "server-only"

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { callGet, callWrite, type CallFailure, type CallResult } from "@/lib/backend/call"
import { verifiedCaller } from "@/lib/http/backend-route-responses"
import type { NextResponse } from "next/server"
import type { ExampleKind } from "@/types/app"

/**
 * The examples CMS through the backend (V0.1.53; PostgreSQL, no Supabase table).
 * Rows keep the shape the UI already uses (snake_case columns of `examples`).
 * Image BYTES are stored by lib/storage/example-media.ts, only after the admin
 * gate and the PostgreSQL record agree.
 */

export interface ExampleRowWire {
  id: string
  kind: ExampleKind
  title: string
  description: string | null
  character_id: string | null
  media_url: string
  thumbnail_url: string | null
  is_published: boolean
  sort_order: number
  created_at: string
  updated_at: string
  badge_label: string
}

const rows = (v: unknown): ExampleRowWire[] | null => (Array.isArray(v) ? (v as ExampleRowWire[]) : null)
const row = (v: unknown): ExampleRowWire | null => (v && typeof v === "object" && typeof (v as ExampleRowWire).id === "string" ? (v as ExampleRowWire) : null)

/** Published examples for the public page. null = the backend could not answer. */
export async function loadPublicExamples(): Promise<ExampleRowWire[] | null> {
  const r = await callGet(null, "examples_public", "/v1/public/examples")
  return r.ok ? rows(r.body.examples) : null
}

/** Admin pages: verify the session, then list through the backend (admin role enforced there). null = unavailable/forbidden. */
export async function loadAdminExamples(): Promise<ExampleRowWire[] | null> {
  const caller = await verifiedCaller()
  if (!caller.ok) return null
  const r = await callGet(caller.context, "examples_admin_list", "/v1/admin/examples")
  return r.ok ? rows(r.body.examples) : null
}

/** The admin list for the API route: the failure (403 for a parent, 401, 503) is kept so the route answers it. */
export async function adminExamplesResult(context: VerifiedAuthContext): Promise<{ ok: true; data: ExampleRowWire[] } | CallFailure> {
  const r = await callGet(context, "examples_admin_list", "/v1/admin/examples")
  if (!r.ok) return r
  const data = rows(r.body.examples)
  return data ? { ok: true, data } : { ok: false, kind: "unavailable", outcomeUnknown: false }
}

/** "missing" = a definite 404; null = could not read. */
export async function loadAdminExample(id: string): Promise<ExampleRowWire | "missing" | null> {
  const caller = await verifiedCaller()
  if (!caller.ok) return null
  const r = await callGet(caller.context, "examples_admin_get", `/v1/admin/examples/${id.toLowerCase()}`)
  if (r.ok) return row(r.body.example)
  return r.kind === "refused" && r.status === 404 ? "missing" : null
}

export const createExampleRow = (c: VerifiedAuthContext, body: Record<string, unknown>) => callWrite(c, "example_create", "POST", "/v1/admin/examples", body)
export const updateExampleRow = (c: VerifiedAuthContext, id: string, fields: Record<string, unknown>) => callWrite(c, "example_update", "PATCH", `/v1/admin/examples/${id.toLowerCase()}`, fields)
export const replaceExampleMediaRow = (c: VerifiedAuthContext, id: string, mediaUrl: string) => callWrite(c, "example_media", "PUT", `/v1/admin/examples/${id.toLowerCase()}/media`, { media_url: mediaUrl })
export const deleteExampleRow = (c: VerifiedAuthContext, id: string) => callWrite(c, "example_delete", "DELETE", `/v1/admin/examples/${id.toLowerCase()}`, {})
export const exampleOf = (r: CallResult): ExampleRowWire | null => (r.ok ? row(r.body.example) : null)

/** The admin gate (nothing written) asked before any image byte is stored. */
export const exampleAdminGate = (c: VerifiedAuthContext) => callGet(c, "cms_gate", "/v1/admin/cms/gate")

/** Existing JSON error shape of these routes (English texts), from a failed call. */
export async function exampleFailureResponse(f: CallFailure, json: (b: unknown, status: number) => NextResponse): Promise<NextResponse> {
  if (f.kind === "auth") {
    if (f.reason === "forbidden" || f.reason === "identity_not_linked") return json({ error: "Forbidden" }, 403)
    return json({ error: "Unauthorized" }, 401)
  }
  if (f.kind === "refused") {
    if (f.error === "example_admin_not_found") return json({ error: "Example not found" }, 404)
    if (f.error === "example_admin_forbidden") return json({ error: "Forbidden" }, 403)
    if (f.status === 400) return json({ error: "Invalid request" }, 400)
    return json({ error: "Validation failed", errors: [{ field: "request", message: "Rejected" }] }, 422)
  }
  return json({ error: f.outcomeUnknown ? "Result unknown. Reload the page." : "Service unavailable" }, 503)
}

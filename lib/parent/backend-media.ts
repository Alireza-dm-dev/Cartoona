import "server-only"

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { backendGetJson, backendWriteJson } from "@/lib/backend/client"
import { isBackendClientError } from "@/lib/backend/errors"
import { currentRequestId } from "@/lib/observability/request-context"
import { mapBackendRejection, type BackendParentRejection, type ParentBackendFailure } from "./backend-caller"

/**
 * Parent media METADATA through the backend (V0.1.52): the gallery page, one
 * owned source asset (request re-use), the current final deliverable's key and
 * the final-media access audit. Each call is one attempt, never retried.
 *
 * The backend returns object KEYS (`path`) only after PostgreSQL ownership /
 * visibility predicates selected the row; they go to the callers in this
 * process, which sign them with the Storage provider. Nothing here touches
 * Supabase Database.
 */

export type MediaCallFailure =
  | { ok: false; kind: "auth"; reason: ParentBackendFailure }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "invalid" }
  | { ok: false; kind: "unavailable"; outcomeUnknown: boolean }

type Outcome = { status: number; body: Record<string, unknown> }
const relay = (json: unknown, status: number): Outcome => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body")
  return { status, body: json as Record<string, unknown> }
}
const ACCEPT = [400, 401, 403, 404, 409, 503] as const
const AUTH_ERRORS = new Set(["unauthenticated", "session_expired", "session_invalidated", "identity_not_linked", "forbidden", "parent_profile_not_found"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

function failure(out: Outcome): MediaCallFailure {
  const error = typeof out.body.error === "string" ? out.body.error : ""
  if (out.status === 401 || AUTH_ERRORS.has(error)) {
    return { ok: false, kind: "auth", reason: mapBackendRejection((AUTH_ERRORS.has(error) ? error : "unauthenticated") as BackendParentRejection) }
  }
  if (out.status === 503) return { ok: false, kind: "unavailable", outcomeUnknown: false }
  if (out.status === 404) return { ok: false, kind: "not_found" }
  return { ok: false, kind: "invalid" }
}

async function get(context: VerifiedAuthContext, operation: string, path: string, query?: Record<string, string | undefined>): Promise<Outcome | MediaCallFailure> {
  try {
    const { data } = await backendGetJson({ operation, path, query, requestId: currentRequestId(), auth: context, acceptStatuses: ACCEPT, parse: relay })
    return data.status >= 200 && data.status < 300 ? data : failure(data)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: false }
    throw error
  }
}

const isFailure = (x: Outcome | MediaCallFailure): x is MediaCallFailure => "ok" in x

export interface BackendGalleryItem {
  id: string
  mimeType: string | null
  createdAt: string
  originalFilename: string | null
  path: string
}

export async function fetchGalleryPage(
  context: VerifiedAuthContext,
  options: { cursor?: string | null; limit?: number },
): Promise<{ ok: true; items: BackendGalleryItem[]; nextCursor: string | null } | MediaCallFailure> {
  const out = await get(context, "parent_gallery", "/v1/parent/gallery", {
    cursor: options.cursor || undefined,
    limit: options.limit === undefined ? undefined : String(options.limit),
  })
  if (isFailure(out)) return out
  const list = out.body.items
  const next = out.body.nextCursor
  if (!Array.isArray(list) || list.length > 100 || (next !== null && typeof next !== "string")) {
    return { ok: false, kind: "unavailable", outcomeUnknown: false }
  }
  const items: BackendGalleryItem[] = []
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>
    if (typeof r.id !== "string" || !UUID.test(r.id) || typeof r.createdAt !== "string" || !TIMESTAMP.test(r.createdAt) || typeof r.path !== "string" || r.path.length === 0) {
      return { ok: false, kind: "unavailable", outcomeUnknown: false }
    }
    items.push({
      id: r.id,
      mimeType: typeof r.mimeType === "string" ? r.mimeType : null,
      createdAt: r.createdAt,
      originalFilename: typeof r.originalFilename === "string" ? r.originalFilename : null,
      path: r.path,
    })
  }
  return { ok: true, items, nextCursor: next as string | null }
}

export async function fetchOwnedSourceAsset(
  context: VerifiedAuthContext,
  assetId: string,
): Promise<{ ok: true; path: string; mimeType: string | null; originalFilename: string | null } | MediaCallFailure> {
  if (!UUID.test(assetId)) return { ok: false, kind: "not_found" }
  const out = await get(context, "parent_gallery_asset", `/v1/parent/gallery/${assetId.toLowerCase()}`)
  if (isFailure(out)) return out
  const b = out.body
  if (typeof b.path !== "string" || b.path.length === 0) return { ok: false, kind: "unavailable", outcomeUnknown: false }
  return {
    ok: true,
    path: b.path,
    mimeType: typeof b.mimeType === "string" ? b.mimeType : null,
    originalFilename: typeof b.originalFilename === "string" ? b.originalFilename : null,
  }
}

export async function authorizeFinalMedia(
  context: VerifiedAuthContext,
  orderId: string,
): Promise<{ ok: true; assetId: string; path: string; mimeType: string | null; fileName: string | null } | MediaCallFailure> {
  if (!UUID.test(orderId)) return { ok: false, kind: "not_found" }
  const out = await get(context, "parent_final_media", `/v1/parent/orders/${orderId.toLowerCase()}/final-media`)
  if (isFailure(out)) return out
  const b = out.body
  if (typeof b.assetId !== "string" || !UUID.test(b.assetId) || typeof b.path !== "string" || b.path.length === 0) {
    return { ok: false, kind: "unavailable", outcomeUnknown: false }
  }
  return {
    ok: true,
    assetId: b.assetId,
    path: b.path,
    mimeType: typeof b.mimeType === "string" ? b.mimeType : null,
    fileName: typeof b.fileName === "string" ? b.fileName : null,
  }
}

/** The audit row for a signed view/download. Best-effort for the caller (logged, never fails the response). */
export async function recordFinalMediaAccess(
  context: VerifiedAuthContext,
  orderId: string,
  assetId: string,
  action: "view" | "download",
): Promise<{ ok: true } | MediaCallFailure> {
  try {
    const { data } = await backendWriteJson({
      operation: "parent_final_media_access",
      method: "POST",
      path: `/v1/parent/orders/${orderId.toLowerCase()}/final-media/access`,
      body: { assetId, action },
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: ACCEPT,
      parse: relay,
    })
    return data.status >= 200 && data.status < 300 ? { ok: true } : failure(data)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: error.outcomeUnknown }
    throw error
  }
}

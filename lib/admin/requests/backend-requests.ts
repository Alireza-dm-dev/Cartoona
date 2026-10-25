import "server-only"

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { backendGetJson, backendWriteJson } from "@/lib/backend/client"
import { isBackendClientError } from "@/lib/backend/errors"
import { currentRequestId } from "@/lib/observability/request-context"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createPrivateSignedUrls } from "@/lib/storage/private-signed-url"
import { signFinalDeliverable } from "@/lib/storage/final-deliverables"
import type { OrderStatus, OrderType } from "@/types/app"
import type { FulfilmentApiErrorCode } from "@/lib/admin/requests/fulfilment-error-codes"
import { mapFulfilmentRpcError } from "@/lib/admin/requests/fulfilment-errors"
import {
  toAdminFinalMediaInfo,
  toAdminHistoryItem,
  type AdminFinalMediaInfo,
  type AdminHistoryItem,
  type AdminStatusUpdateInput,
  type AdminStatusUpdateResult,
} from "@/lib/admin/requests/fulfilment-types"
import { mapChildNameRow, mapMediaAsset, mapOrderDetail, mapQueueRow, mapVideoTypeRows } from "@/lib/admin/requests/mappers"
import type { AdminMediaAssetInfo, AdminOrderDetail, AdminQueueResult, AdminTypeDetailRow } from "@/lib/admin/requests/types"
import { clampPage } from "@/lib/admin/requests/validation"

/**
 * Admin request views and fulfilment through the backend (V0.1.52). The only
 * path from Next for the admin queue, request detail, status changes and
 * final-media records; no Supabase table or RPC is read or written here.
 *
 *   reads   verified context -> v2 assertion -> Fastify (admin role check) -> PostgreSQL
 *   writes  verified context -> v3 assertion (body digest + nonce) -> Fastify (admin role)
 *           -> trusted function (re-checks the role, locks, transition map, history)
 *
 * The acting admin is never sent in a body: it is the assertion's subject. A
 * parent's context is refused by the backend (403), never by anything here.
 * Storage is bytes only: source previews are signed with the caller's session
 * client (path-prefix policy); final deliverables with the service credential
 * after PostgreSQL returned the key. A signing failure leaves `signedUrl: null`
 * and the page still renders.
 */

const ACCEPT = [400, 401, 403, 404, 409, 413, 422, 503] as const
type Outcome = { status: number; body: Record<string, unknown> }
const relay = (json: unknown, status: number): Outcome => {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body")
  return { status, body: json as Record<string, unknown> }
}
const AUTH_TOKENS = new Set(["unauthenticated", "session_expired", "session_invalidated", "identity_not_linked", "forbidden"])

export type AdminCallFailure =
  | { ok: false; kind: "auth"; reason: "unauthenticated" | "session_expired" | "forbidden" }
  | { ok: false; kind: "refused"; status: number; code: FulfilmentApiErrorCode; message: string }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "unavailable"; outcomeUnknown: boolean }

function failure(out: Outcome): AdminCallFailure {
  const error = typeof out.body.error === "string" ? out.body.error : ""
  if (out.status === 401) return { ok: false, kind: "auth", reason: error === "session_expired" || error === "session_invalidated" ? "session_expired" : "unauthenticated" }
  if (out.status === 403 && AUTH_TOKENS.has(error)) return { ok: false, kind: "auth", reason: "forbidden" }
  if (out.status === 503) return { ok: false, kind: "unavailable", outcomeUnknown: false }
  if (out.status === 404 && error === "request_not_found") return { ok: false, kind: "not_found" }
  if (out.status === 409 && error === "replayed_request") return { ok: false, kind: "unavailable", outcomeUnknown: true }
  const code = typeof out.body.code === "string" ? out.body.code : null
  if ((out.status === 400 || out.status === 422) && error === "invalid_request") {
    return { ok: false, kind: "refused", status: 422, code: (code as FulfilmentApiErrorCode) ?? "REQUEST_INVALID_BODY", message: "درخواست نامعتبر است" }
  }
  const mapped = mapFulfilmentRpcError(error)
  return { ok: false, kind: "refused", status: mapped.status, code: mapped.code, message: mapped.message }
}

async function get(context: VerifiedAuthContext, operation: string, path: string, query?: Record<string, string | undefined>): Promise<Outcome | AdminCallFailure> {
  try {
    const { data } = await backendGetJson({ operation, path, query, requestId: currentRequestId(), auth: context, acceptStatuses: ACCEPT, parse: relay })
    return data.status >= 200 && data.status < 300 ? data : failure(data)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: false }
    throw error
  }
}

async function write(context: VerifiedAuthContext, operation: string, method: "POST" | "PATCH", path: string, body: unknown): Promise<Outcome | AdminCallFailure> {
  try {
    const { data } = await backendWriteJson({ operation, method, path, body, requestId: currentRequestId(), auth: context, acceptStatuses: ACCEPT, parse: relay })
    if (data.status >= 200 && data.status < 300) return data
    // A database failure on a WRITE may have happened after the commit: never "definitely not saved".
    if (data.status === 503) return { ok: false, kind: "unavailable", outcomeUnknown: true }
    return failure(data)
  } catch (error) {
    if (isBackendClientError(error)) return { ok: false, kind: "unavailable", outcomeUnknown: error.outcomeUnknown }
    throw error
  }
}

const isFailure = (x: Outcome | AdminCallFailure): x is AdminCallFailure => "ok" in x
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const rows = (v: unknown, max: number): Record<string, unknown>[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("rows")
  return v as Record<string, unknown>[]
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function loadAdminQueue(
  context: VerifiedAuthContext,
  input: { type: OrderType | null; status: OrderStatus | null; page: number; pageSize: number },
): Promise<AdminQueueResult | null> {
  const out = await get(context, "admin_request_queue", "/v1/admin/requests", {
    type: input.type ?? undefined,
    status: input.status ?? undefined,
    page: String(input.page),
    pageSize: String(input.pageSize),
  })
  if (isFailure(out)) return null
  try {
    const list = rows(out.body.requests, 100)
    const total = Number((out.body.pagination as Record<string, unknown>)?.total ?? 0)
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize))
    return {
      rows: list.map((r) =>
        mapQueueRow({
          id: String(r.id),
          type: String(r.type),
          status: String(r.status),
          title: str(r.title),
          candy_cost: Number(r.candy_cost),
          created_at: String(r.created_at),
          updated_at: String(r.updated_at),
          parentFullName: str(r.parent_full_name),
          parentProfileMissing: r.parent_missing === true,
          childProfileId: null,
        }),
      ),
      pagination: { page: clampPage(input.page, totalPages), pageSize: input.pageSize, total, totalPages },
      hasFilters: input.type !== null || input.status !== null,
    }
  } catch {
    return null
  }
}

export interface AdminRequestView {
  detail: AdminOrderDetail
  finalMedia: AdminFinalMediaInfo[]
  history: AdminHistoryItem[]
}

export type AdminRequestViewResult =
  | { ok: true; view: AdminRequestView }
  | { ok: false; reason: "not_found" | "forbidden" | "unauthenticated" | "unavailable" }

export async function loadAdminRequestView(context: VerifiedAuthContext, requestId: string): Promise<AdminRequestViewResult> {
  const out = await get(context, "admin_request_detail", `/v1/admin/requests/${requestId.toLowerCase()}`)
  if (isFailure(out)) {
    if (out.kind === "not_found") return { ok: false, reason: "not_found" }
    if (out.kind === "auth") return { ok: false, reason: out.reason === "forbidden" ? "forbidden" : "unauthenticated" }
    return { ok: false, reason: "unavailable" }
  }
  try {
    const o = out.body.order as Record<string, unknown>
    const media = rows(out.body.media, 500)
    const history = rows(out.body.history, 1000)
    const type = String(o.type)
    const uploads = media.filter((m) => m.type === "upload")
    const hasUpload = uploads.length > 0

    let typeRows: AdminTypeDetailRow[] = []
    if (type === "video") {
      typeRows = mapVideoTypeRows({
        script: str(o.video_script)?.trim() || null,
        style: str(o.video_style)?.trim() || null,
        durationChoice: str(o.video_duration_choice),
        durationSeconds: typeof o.video_duration_seconds === "number" ? o.video_duration_seconds : null,
        charactersSpeak: typeof o.video_characters_speak === "boolean" ? o.video_characters_speak : null,
        referenceFile: hasUpload,
        childName: str(o.child_name),
      })
    } else if (type === "drawing_animation") {
      const sourceDrawing = Boolean(o.drawing_upload_url) || hasUpload
      typeRows = [
        { label: "سبک انیمیشن", value: str(o.drawing_animation_style)?.trim() || "ثبت نشده" },
        { label: "نقاشی منبع", value: sourceDrawing ? "بارگذاری شده" : "بارگذاری نشده" },
      ]
    } else if (type === "image") {
      const childRow = mapChildNameRow(str(o.child_name))
      typeRows = [...(childRow ? [childRow] : []), { label: "فایل مرجع", value: hasUpload ? "بارگذاری شده" : "بارگذاری نشده" }]
    }

    // Storage = bytes only. Source previews: the caller's session client, one batch.
    let signedSources = new Map<string, string | null>()
    if (uploads.length > 0) {
      try {
        const supabase = await createServerSupabaseClient()
        signedSources = await createPrivateSignedUrls(supabase, uploads.map((m) => String(m.path)))
      } catch {
        signedSources = new Map()
      }
    }
    const sourceMedia: AdminMediaAssetInfo[] = uploads.map((m) =>
      mapMediaAsset(
        { id: String(m.id), type: String(m.type), file_url: String(m.path), mime_type: str(m.mime_type), created_at: String(m.created_at) },
        signedSources.get(String(m.path)) ?? null,
      ),
    )

    // Final deliverables: signed with the service credential, live assets only.
    const finalMedia: AdminFinalMediaInfo[] = []
    for (const m of media.filter((x) => x.asset_role === "final")) {
      const live = m.delivery_status === "uploaded" || m.delivery_status === "approved"
      const signedUrl = live ? await signFinalDeliverable(String(m.path), 300) : null
      finalMedia.push(
        toAdminFinalMediaInfo(
          {
            id: String(m.id),
            file_url: str(m.path),
            mime_type: str(m.mime_type),
            byte_size: typeof m.byte_size === "number" ? m.byte_size : null,
            created_at: String(m.created_at),
            superseded_at: str(m.superseded_at),
            delivery_status: String(m.delivery_status ?? "uploaded"),
            parent_visible: m.parent_visible === true,
          },
          signedUrl,
        ),
      )
    }

    const detail = mapOrderDetail({
      id: String(o.id),
      type,
      status: String(o.status),
      title: str(o.title),
      description: str(o.description),
      candy_cost: Number(o.candy_cost),
      moderation_status: String(o.moderation_status),
      created_at: String(o.created_at),
      updated_at: String(o.updated_at),
      parentFullName: o.parent_missing === true ? null : str(o.parent_full_name)?.trim() || null,
      parentEmail: o.parent_missing === true ? null : str(o.parent_email),
      parentProfileMissing: o.parent_missing === true,
      childProfileId: null,
      characterName: str(o.character_name),
      consentGranted: false,
      typeRows,
      media: sourceMedia,
    })

    return {
      ok: true,
      view: {
        detail,
        finalMedia,
        history: history.map((r) =>
          toAdminHistoryItem({
            id: String(r.id ?? ""),
            previous_status: str(r.previous_status),
            new_status: String(r.new_status ?? "pending_review"),
            changed_by: str(r.changed_by_name),
            changed_by_deleted: r.changed_by_deleted === true,
            internal_note: str(r.internal_note),
            parent_visible_note: str(r.parent_visible_note),
            created_at: String(r.created_at ?? ""),
          }),
        ),
      },
    }
  } catch {
    return { ok: false, reason: "unavailable" }
  }
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function adminUpdateStatus(
  context: VerifiedAuthContext,
  requestId: string,
  input: AdminStatusUpdateInput,
): Promise<{ ok: true; result: AdminStatusUpdateResult; replayed: boolean } | AdminCallFailure> {
  const out = await write(context, "admin_request_status", "PATCH", `/v1/admin/requests/${requestId.toLowerCase()}/status`, {
    status: input.status,
    expectedUpdatedAt: input.expectedUpdatedAt,
    internalNote: input.internalNote,
    parentVisibleNote: input.parentVisibleNote,
  })
  if (isFailure(out)) return out
  const b = out.body
  if (typeof b.orderId !== "string" || typeof b.status !== "string" || typeof b.updatedAt !== "string") {
    return { ok: false, kind: "unavailable", outcomeUnknown: true }
  }
  return {
    ok: true,
    replayed: b.replayed === true,
    result: {
      orderId: b.orderId,
      previousStatus: (str(b.previousStatus) ?? null) as AdminStatusUpdateResult["previousStatus"],
      status: b.status as OrderStatus,
      updatedAt: b.updatedAt,
      historyId: str(b.historyId) ?? "",
    },
  }
}

export async function adminRecordFinalMedia(
  context: VerifiedAuthContext,
  requestId: string,
  file: { filePath: string; mimeType: string; byteSize: number; originalFilename: string },
): Promise<{ ok: true; assetId: string } | AdminCallFailure> {
  const out = await write(context, "admin_final_media_record", "POST", `/v1/admin/requests/${requestId.toLowerCase()}/final-media`, file)
  if (isFailure(out)) return out
  if (typeof out.body.assetId !== "string") return { ok: false, kind: "unavailable", outcomeUnknown: true }
  return { ok: true, assetId: out.body.assetId }
}

export async function adminFinalMediaAction(
  context: VerifiedAuthContext,
  requestId: string,
  assetId: string,
  action: "approve" | "supersede",
): Promise<{ ok: true; assetId: string } | AdminCallFailure> {
  const out = await write(context, "admin_final_media_" + action, "PATCH", `/v1/admin/requests/${requestId.toLowerCase()}/final-media/${assetId.toLowerCase()}`, { action })
  if (isFailure(out)) return out
  if (typeof out.body.assetId !== "string") return { ok: false, kind: "unavailable", outcomeUnknown: true }
  return { ok: true, assetId: out.body.assetId }
}

/** Asked BEFORE any object bytes are written: an admin, an existing order, a status that allows a final upload. */
export async function adminUploadGate(context: VerifiedAuthContext, requestId: string): Promise<{ ok: true } | AdminCallFailure> {
  const out = await get(context, "admin_upload_gate", `/v1/admin/requests/${requestId.toLowerCase()}/upload-gate`)
  if (isFailure(out)) return out
  return out.body.allowed === true ? { ok: true } : { ok: false, kind: "unavailable", outcomeUnknown: false }
}

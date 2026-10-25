import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { mapFulfilmentRpcError } from "@/lib/admin/requests/fulfilment-errors"
import { parseAdminStatusUpdateInput } from "@/lib/admin/requests/fulfilment-types"
import { FINAL_IMAGE_MIME_TYPES, FINAL_MEDIA_MIME_TYPES, MAX_FINAL_IMAGE_BYTES, MAX_FINAL_VIDEO_BYTES } from "@/lib/admin/requests/media-validation"
import { ALL_ORDER_STATUSES, FINAL_UPLOAD_ALLOWED_STATUSES } from "@/lib/admin/requests/workflow"
import {
  approveFinalMedia,
  getAdminOrderData,
  getOrderState,
  listAdminQueue,
  recordFinalMedia,
  supersedeFinalMedia,
  updateOrderStatus,
} from "@/lib/repositories/admin-requests"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * ADMIN REQUESTS (V0.1.52): queue, detail and fulfilment on PostgreSQL.
 *
 *   GET   /v1/admin/requests?type&status&page&pageSize          v2, admin
 *   GET   /v1/admin/requests/:requestId                         v2, admin   order + media metadata + history
 *   GET   /v1/admin/requests/:requestId/upload-gate             v2, admin   may final bytes be uploaded now? (nothing written)
 *   PATCH /v1/admin/requests/:requestId/status                  v3, admin   { status, expectedUpdatedAt, internalNote, parentVisibleNote }
 *   POST  /v1/admin/requests/:requestId/final-media             v3, admin   { filePath, mimeType, byteSize, originalFilename }
 *   PATCH /v1/admin/requests/:requestId/final-media/:assetId    v3, admin   { action: approve | supersede }
 *
 * The acting admin is ONLY `request.authPrincipal`; a parent is refused by the
 * role check before any handler, and the trusted functions re-check the admin
 * role in PostgreSQL. The state machine, optimistic concurrency, the
 * final-media-required rule and the append-only history live in
 * update_order_status_trusted (one statement: order update + ONE history row).
 *
 * Final media: the bytes were already written to Storage by the Next BFF (the
 * only caller that holds a storage credential); this route records the LINK.
 * The key must be exactly orders/<requestId>/final/<uuid>.<ext> with an
 * allow-listed MIME type and a size within the type's cap, and the function
 * re-checks the prefix. Function refusals answer `{ error: <token> }` with the
 * HTTP status of mapFulfilmentRpcError; the Next route turns the token into the
 * Persian message.
 *
 * Retry rule for status: a SECOND assertion (new nonce) repeating a transition
 * that already committed (stale expectedUpdatedAt, current status == target) is
 * answered 200 with `replayed: true` and the CURRENT state, writing no second
 * history row; the same assertion twice is 409 replayed_request from the nonce;
 * a no-op with a current token stays 409 request_status_unchanged.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_RE = /^orders\/([0-9a-f-]{36})\/final\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|mp4|webm)$/i
const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" }
const TYPES = new Set(["image", "video", "drawing_animation"])
const STATUSES = new Set<string>(ALL_ORDER_STATUSES)
const LIST_KEYS = new Set(["type", "status", "page", "pageSize"])
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50
const FILENAME_MAX = 255
const SMALL_BODY_LIMIT = 8 * 1024
const TINY_BODY_LIMIT = 1024

function dbFailure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (error instanceof DbError && error.kind === "business" && error.businessCode?.startsWith("request_")) {
    const mapped = mapFulfilmentRpcError(error.businessCode)
    logEvent("info", "ADMIN_REQUEST_REFUSED", { requestId: request.id, operation, reason: error.businessCode })
    return reply.code(mapped.status).send({ error: error.businessCode })
  }
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", "ADMIN_REQUEST_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return fallback
  const n = Number(value)
  return n >= 1 ? n : fallback
}

function idParam(request: FastifyRequest, name: string): string | null {
  const id = (request.params as Record<string, string | undefined>)[name]
  return typeof id === "string" && UUID.test(id) ? id : null
}

export function registerAdminRequestRoutes(app: FastifyInstance, deps: BackendDeps): void {
  const read = { preHandler: [requireAuth(deps), requireRole("admin", "super_admin")] }

  app.get("/v1/admin/requests", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const q = (request.query ?? {}) as Record<string, unknown>
    if (Object.keys(q).some((k) => !LIST_KEYS.has(k))) return reply.code(400).send({ error: "invalid_request" })
    const type = typeof q.type === "string" && TYPES.has(q.type) ? q.type : null
    const status = typeof q.status === "string" && STATUSES.has(q.status) ? q.status : null
    const page = positiveInt(q.page, 1)
    const pageSize = Math.min(positiveInt(q.pageSize, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX)
    try {
      const { rows, total } = await listAdminQueue(deps.db(), { type, status, page, pageSize })
      return { requests: rows, pagination: { page, pageSize, total, totalPages: total > 0 ? Math.ceil(total / pageSize) : 0 } }
    } catch (error) {
      return dbFailure(request, reply, "admin_request_list", error)
    }
  })

  app.get("/v1/admin/requests/:requestId", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const requestId = idParam(request, "requestId")
    if (!requestId) return reply.code(404).send({ error: "request_not_found" })
    try {
      const data = await getAdminOrderData(deps.db(), { adminUserId: request.authPrincipal!.userId, orderId: requestId })
      if (!data) return reply.code(404).send({ error: "request_not_found" })
      return data
    } catch (error) {
      return dbFailure(request, reply, "admin_request_detail", error)
    }
  })

  // Gate for the Next BFF BEFORE it writes object bytes: an admin, an existing
  // order, a status that allows a final upload. Nothing is written here.
  app.get("/v1/admin/requests/:requestId/upload-gate", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const requestId = idParam(request, "requestId")
    if (!requestId) return reply.code(404).send({ error: "request_not_found" })
    try {
      const state = await getOrderState(deps.db(), requestId)
      if (!state) return reply.code(404).send({ error: "request_not_found" })
      if (!(FINAL_UPLOAD_ALLOWED_STATUSES as readonly string[]).includes(state.status)) {
        return reply.code(409).send({ error: "request_upload_not_allowed" })
      }
      return { allowed: true }
    } catch (error) {
      return dbFailure(request, reply, "admin_upload_gate", error)
    }
  })

  app.patch("/v1/admin/requests/:requestId/status", { bodyLimit: SMALL_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const requestId = idParam(request, "requestId")
    if (!requestId) return reply.code(404).send({ error: "request_not_found" })
    const parsed = parseAdminStatusUpdateInput(request.body)
    if (!parsed.ok) return reply.code(parsed.status === 400 ? 400 : 422).send({ error: "invalid_request", code: parsed.code })
    const adminUserId = request.authPrincipal!.userId
    try {
      const result = await updateOrderStatus(deps.db(), {
        adminUserId,
        orderId: requestId,
        status: parsed.input.status,
        expectedUpdatedAt: parsed.input.expectedUpdatedAt,
        internalNote: parsed.input.internalNote,
        parentVisibleNote: parsed.input.parentVisibleNote,
      })
      logEvent("info", "ADMIN_REQUEST_STATUS_CHANGED", { requestId: request.id, operation: "admin_request_status" })
      return {
        replayed: false,
        orderId: result.order_id,
        previousStatus: result.previous_status,
        status: result.new_status,
        updatedAt: result.updated_at,
        historyId: result.history_id,
      }
    } catch (error) {
      if (error instanceof DbError && error.kind === "business" && error.businessCode === "request_status_conflict") {
        // A STALE token whose target is already the current status is a retry of a transition that
        // already committed (new nonce): report the current state, write nothing. A CURRENT token
        // with an unchanged status stays request_status_unchanged (409), exactly as before.
        try {
          const state = await getOrderState(deps.db(), requestId)
          if (state && state.status === parsed.input.status) {
            return { replayed: true, orderId: requestId, previousStatus: null, status: state.status, updatedAt: state.updated_at, historyId: state.history_id }
          }
        } catch {
          // fall through to the original refusal
        }
      }
      return dbFailure(request, reply, "admin_request_status", error)
    }
  })

  app.post("/v1/admin/requests/:requestId/final-media", { bodyLimit: SMALL_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const requestId = idParam(request, "requestId")
    if (!requestId) return reply.code(404).send({ error: "request_not_found" })
    const body = request.body as Record<string, unknown> | null
    const KEYS = ["filePath", "mimeType", "byteSize", "originalFilename"]
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== KEYS.length || KEYS.some((k) => !(k in body))) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    const { filePath, mimeType, byteSize, originalFilename } = body
    if (typeof filePath !== "string" || typeof mimeType !== "string" || typeof originalFilename !== "string" ||
        typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 0 || originalFilename.length > FILENAME_MAX) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    // Namespace, type, ownership-of-order and size: the key must be THIS order's final folder.
    const key = KEY_RE.exec(filePath)
    const ok =
      key !== null &&
      key[1].toLowerCase() === requestId.toLowerCase() &&
      FINAL_MEDIA_MIME_TYPES.includes(mimeType) &&
      EXT_MIME[key[2].toLowerCase()] === mimeType &&
      byteSize <= (FINAL_IMAGE_MIME_TYPES.includes(mimeType) ? MAX_FINAL_IMAGE_BYTES : MAX_FINAL_VIDEO_BYTES)
    if (!ok) return reply.code(422).send({ error: "request_file_invalid" })
    try {
      const assetId = await recordFinalMedia(deps.db(), {
        adminUserId: request.authPrincipal!.userId,
        orderId: requestId,
        filePath,
        mimeType,
        byteSize,
        originalFilename,
      })
      logEvent("info", "ADMIN_FINAL_MEDIA_RECORDED", { requestId: request.id, operation: "admin_final_media_record" })
      return { assetId }
    } catch (error) {
      return dbFailure(request, reply, "admin_final_media_record", error)
    }
  })

  app.patch("/v1/admin/requests/:requestId/final-media/:assetId", { bodyLimit: TINY_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const requestId = idParam(request, "requestId")
    if (!requestId) return reply.code(404).send({ error: "request_not_found" })
    const assetId = idParam(request, "assetId")
    if (!assetId) return reply.code(404).send({ error: "request_asset_not_found" })
    const body = request.body as Record<string, unknown> | null
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
        (body.action !== "approve" && body.action !== "supersede")) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const adminUserId = request.authPrincipal!.userId
      const id = body.action === "approve"
        ? await approveFinalMedia(deps.db(), { adminUserId, orderId: requestId, assetId })
        : await supersedeFinalMedia(deps.db(), { adminUserId, orderId: requestId, assetId })
      return { assetId: id, deliveryStatus: body.action === "approve" ? "approved" : "superseded" }
    } catch (error) {
      return dbFailure(request, reply, "admin_final_media_" + String(body.action), error)
    }
  })
}

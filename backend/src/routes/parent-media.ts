import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import {
  GALLERY_DEFAULT_PAGE_SIZE,
  GALLERY_MAX_PAGE_SIZE,
  decodeGalleryCursor,
  encodeGalleryCursor,
} from "@/lib/parent/gallery/pagination"
import {
  findCurrentFinalMedia,
  findOwnedSourceAsset,
  getParentOrderDetailData,
  listGalleryPage,
  recordFinalMediaAccess,
} from "@/lib/repositories/parent-media"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * PARENT ORDER DETAIL, GALLERY AND FINAL-MEDIA METADATA (V0.1.52).
 *
 *   GET  /v1/parent/orders/:orderId                      v2, parent   order detail + source/final METADATA
 *   GET  /v1/parent/orders/:orderId/final-media          v2, parent   the current final deliverable's object key
 *   POST /v1/parent/orders/:orderId/final-media/access   v3, parent   audit row for a view/download that was signed
 *   GET  /v1/parent/gallery?cursor&limit                 v2, parent   one page of the parent's own source uploads
 *   GET  /v1/parent/gallery/:assetId                     v2, parent   one owned source asset's key (request re-use)
 *
 * The caller is ONLY `request.authPrincipal` -> the parent profile resolved
 * here; every statement filters on that profile, so another parent's order or
 * asset is indistinguishable from a missing one (404 / `{ item: null }`).
 *
 * The responses carry object KEYS. They go only to the Next BFF, which signs
 * them server-side after this authorization and never forwards a key to a
 * browser. No bucket, URL or credential exists in this process. Every answer
 * is no-store; database failures are 503 with a category-only log.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GALLERY_KEYS = new Set(["cursor", "limit"])

function dbFailure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  if (error instanceof DbError && error.kind === "business" && error.businessCode === "audit_not_allowed") {
    return reply.code(404).send({ error: "not_found" })
  }
  logEvent("warn", "PARENT_MEDIA_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

function orderIdParam(request: FastifyRequest): string | null {
  const id = (request.params as { orderId?: string }).orderId
  return typeof id === "string" && UUID.test(id) ? id : null
}

export function registerParentMediaRoutes(app: FastifyInstance, deps: BackendDeps): void {
  const read = { preHandler: [requireAuth(deps), requireRole("parent")] }

  app.get("/v1/parent/orders/:orderId", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const orderId = orderIdParam(request)
    if (!orderId) return reply.code(404).send({ error: "not_found" })
    try {
      const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId: request.authPrincipal!.userId })
      if (!parentProfileId) return reply.code(404).send({ error: "parent_profile_not_found" })
      const data = await getParentOrderDetailData(deps.db(), { parentProfileId, orderId })
      if (!data) return reply.code(404).send({ error: "not_found" })
      return {
        order: data.order,
        sourceMedia: data.sourceMedia.map((m) => ({ id: m.id, mimeType: m.mime_type, uploadedAt: m.created_at, path: m.path })),
        history: data.history,
        finalMedia: data.finalMedia,
      }
    } catch (error) {
      return dbFailure(request, reply, "parent_order_detail", error)
    }
  })

  app.get("/v1/parent/orders/:orderId/final-media", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const orderId = orderIdParam(request)
    if (!orderId) return reply.code(404).send({ error: "not_found" })
    try {
      const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId: request.authPrincipal!.userId })
      if (!parentProfileId) return reply.code(404).send({ error: "parent_profile_not_found" })
      const media = await findCurrentFinalMedia(deps.db(), { parentProfileId, orderId })
      if (!media) return reply.code(404).send({ error: "not_found" })
      return { assetId: media.id, path: media.path, mimeType: media.mime_type, fileName: media.file_name }
    } catch (error) {
      return dbFailure(request, reply, "parent_final_media", error)
    }
  })

  app.post(
    "/v1/parent/orders/:orderId/final-media/access",
    { preHandler: [requireWriteAuth(deps, "parent")] },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const orderId = orderIdParam(request)
      if (!orderId) return reply.code(404).send({ error: "not_found" })
      const body = request.body as Record<string, unknown> | null
      if (
        !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
        typeof body.assetId !== "string" || !UUID.test(body.assetId) ||
        (body.action !== "view" && body.action !== "download")
      ) {
        return reply.code(400).send({ error: "invalid_request" })
      }
      try {
        // The function re-checks owner + current approved parent-visible final.
        await recordFinalMediaAccess(deps.db(), {
          actorUserId: request.authPrincipal!.userId,
          orderId,
          assetId: body.assetId,
          action: body.action === "view" ? "final_media_view" : "final_media_download",
        })
        return { ok: true }
      } catch (error) {
        return dbFailure(request, reply, "parent_final_media_access", error)
      }
    },
  )

  app.get("/v1/parent/gallery", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const q = (request.query ?? {}) as Record<string, unknown>
    if (Object.keys(q).some((k) => !GALLERY_KEYS.has(k))) return reply.code(400).send({ error: "invalid_request" })
    let cursor = null
    if (q.cursor !== undefined && q.cursor !== "") {
      cursor = decodeGalleryCursor(q.cursor)
      if (!cursor) return reply.code(400).send({ error: "invalid_request" })
    }
    let limit = GALLERY_DEFAULT_PAGE_SIZE
    if (q.limit !== undefined) {
      if (typeof q.limit !== "string" || !/^[1-9][0-9]{0,2}$/.test(q.limit)) return reply.code(400).send({ error: "invalid_request" })
      limit = Math.min(Number(q.limit), GALLERY_MAX_PAGE_SIZE)
    }
    try {
      const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId: request.authPrincipal!.userId })
      if (!parentProfileId) return reply.code(404).send({ error: "parent_profile_not_found" })
      const rows = await listGalleryPage(deps.db(), { parentProfileId, cursor, limitPlusOne: limit + 1 })
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      return {
        items: page.map((r) => ({ id: r.id, mimeType: r.mime_type, createdAt: r.created_at, originalFilename: r.original_filename, path: r.path })),
        nextCursor: hasMore && last ? encodeGalleryCursor({ createdAt: last.created_at, id: last.id }) : null,
      }
    } catch (error) {
      return dbFailure(request, reply, "parent_gallery", error)
    }
  })

  app.get("/v1/parent/gallery/:assetId", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const assetId = (request.params as { assetId?: string }).assetId
    if (typeof assetId !== "string" || !UUID.test(assetId)) return reply.code(404).send({ error: "not_found" })
    try {
      const parentProfileId = await findParentProfileIdByUserId(deps.db(), { userId: request.authPrincipal!.userId })
      if (!parentProfileId) return reply.code(404).send({ error: "parent_profile_not_found" })
      const asset = await findOwnedSourceAsset(deps.db(), { parentProfileId, assetId })
      if (!asset) return reply.code(404).send({ error: "not_found" })
      return { path: asset.path, mimeType: asset.mime_type, originalFilename: asset.original_filename }
    } catch (error) {
      return dbFailure(request, reply, "parent_gallery_asset", error)
    }
  })
}

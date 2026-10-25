import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { HOMEPAGE_MEDIA_SLOT_VALUES } from "@/lib/homepage/media-slots"
import {
  deleteHomepageMedia,
  getHeroLayoutRow,
  getHomepageContentRow,
  listHomepageMediaRows,
  recordHomepageMediaReplacement,
  updateHeroLayout,
  updateHomepageContent,
} from "@/lib/repositories/homepage"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * HOMEPAGE CMS (V0.1.53): content, media metadata and hero layout in PostgreSQL.
 *
 *   GET    /v1/public/homepage                       none        the content row + media rows + hero layout (public content)
 *   GET    /v1/admin/cms/gate                        v2, admin   may CMS bytes be stored now? (nothing written)
 *   PUT    /v1/admin/homepage                        v3, admin   { content, expectedRevision }
 *   POST   /v1/admin/homepage/media                  v3, admin   record a replacement the BFF already stored (metadata only)
 *   DELETE /v1/admin/homepage/media                  v3, admin   { slot } revert a slot; returns the previous object key for cleanup
 *   PUT    /v1/admin/homepage/hero-layout            v3, admin   { rect, expectedRevision }
 *
 * The public read needs no identity (it is the public homepage's data) and
 * returns nothing private: published content, object KEYS, a layout rectangle.
 * Writes act as the verified admin only; the trusted functions re-check the
 * role, enforce revisions and validate slot / MIME / key / size. The backend
 * holds no Storage client: bytes were stored by the Next BFF first, and a
 * refused record is cleaned up by it. Function refusals come back as
 * `{ error: <token> }` with a mapped status; the Next route maps the Persian text.
 */

const CONTENT_BODY_LIMIT = 256 * 1024
const MEDIA_BODY_LIMIT = 16 * 1024
const TINY_BODY_LIMIT = 1024
const LAYOUT_BODY_LIMIT = 4096
const SLOTS = new Set<string>(HOMEPAGE_MEDIA_SLOT_VALUES)

function statusFor(token: string): number {
  if (token.endsWith("_forbidden")) return 403
  if (token.endsWith("_not_found") || token.endsWith("_missing")) return 404
  if (token.endsWith("_conflict")) return 409
  return 422
}

function dbFailure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (error instanceof DbError && error.kind === "business" && error.businessCode?.startsWith("homepage_")) {
    logEvent("info", "HOMEPAGE_REFUSED", { requestId: request.id, operation, reason: error.businessCode })
    return reply.code(statusFor(error.businessCode)).send({ error: error.businessCode })
  }
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", "HOMEPAGE_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

export function registerHomepageRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get("/v1/public/homepage", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (Object.keys((request.query ?? {}) as object).length > 0) return reply.code(400).send({ error: "invalid_request" })
    try {
      const [content, media, layout] = await Promise.all([
        getHomepageContentRow(deps.db()),
        listHomepageMediaRows(deps.db()),
        getHeroLayoutRow(deps.db()),
      ])
      return {
        content: content ? { contentJson: content.content_json, revision: content.revision } : null,
        media: media.map((m) => ({
          slotKey: m.slot_key,
          mediaType: m.media_type,
          storagePath: m.storage_path,
          mimeType: m.mime_type,
          byteSize: Number(m.byte_size),
          width: m.width,
          height: m.height,
          durationSeconds: m.duration_seconds === null ? null : Number(m.duration_seconds),
          updatedAt: m.updated_at,
        })),
        heroLayout: layout ? { tvRect: layout.tv_rect, revision: layout.revision } : null,
      }
    } catch (error) {
      return dbFailure(request, reply, "homepage_read", error)
    }
  })

  // Asked by the Next BFF BEFORE it stores any CMS bytes (homepage or examples media): an admin, nothing written.
  app.get("/v1/admin/cms/gate", { preHandler: [requireAuth(deps), requireRole("admin", "super_admin")] }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return { allowed: true }
  })

  app.put("/v1/admin/homepage", { bodyLimit: CONTENT_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const b = request.body
    if (!isObject(b) || Object.keys(b).length !== 2 || !isObject(b.content) || typeof b.expectedRevision !== "number" || !Number.isInteger(b.expectedRevision) || b.expectedRevision < 1) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const row = await updateHomepageContent(deps.db(), { adminUserId: request.authPrincipal!.userId, content: b.content, expectedRevision: b.expectedRevision })
      return { contentJson: row.content_json, revision: row.revision, updatedAt: row.updated_at }
    } catch (error) {
      return dbFailure(request, reply, "homepage_update", error)
    }
  })

  app.post("/v1/admin/homepage/media", { bodyLimit: MEDIA_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const b = request.body
    const KEYS = ["slot", "mediaType", "storagePath", "mimeType", "byteSize", "width", "height", "tvRect", "expectedLayoutRevision", "applyToSections"]
    if (!isObject(b) || Object.keys(b).length !== KEYS.length || KEYS.some((k) => !(k in b)) ||
        typeof b.slot !== "string" || !SLOTS.has(b.slot) || typeof b.mediaType !== "string" || typeof b.storagePath !== "string" ||
        b.storagePath.length === 0 || b.storagePath.length > 512 || typeof b.mimeType !== "string" ||
        typeof b.byteSize !== "number" || !Number.isInteger(b.byteSize) || b.byteSize <= 0 ||
        (b.width !== null && (typeof b.width !== "number" || !Number.isInteger(b.width))) ||
        (b.height !== null && (typeof b.height !== "number" || !Number.isInteger(b.height))) ||
        (b.tvRect !== null && !isObject(b.tvRect)) ||
        (b.expectedLayoutRevision !== null && (typeof b.expectedLayoutRevision !== "number" || !Number.isInteger(b.expectedLayoutRevision))) ||
        typeof b.applyToSections !== "boolean") {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const result = await recordHomepageMediaReplacement(deps.db(), {
        adminUserId: request.authPrincipal!.userId,
        slot: b.slot,
        mediaType: b.mediaType,
        storagePath: b.storagePath,
        mimeType: b.mimeType,
        byteSize: b.byteSize,
        width: b.width as number | null,
        height: b.height as number | null,
        tvRect: b.tvRect,
        expectedLayoutRevision: b.expectedLayoutRevision as number | null,
        applyToSections: b.applyToSections,
      })
      logEvent("info", "HOMEPAGE_MEDIA_RECORDED", { requestId: request.id, operation: "homepage_media_record" })
      return { result }
    } catch (error) {
      return dbFailure(request, reply, "homepage_media_record", error)
    }
  })

  // The slot travels in the body, not the path: slot keys contain dots (hero.background) and backend paths are dot-free constants.
  app.delete("/v1/admin/homepage/media", { bodyLimit: TINY_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const b = request.body
    if (!isObject(b) || Object.keys(b).length !== 1 || typeof b.slot !== "string") return reply.code(400).send({ error: "invalid_request" })
    if (!SLOTS.has(b.slot)) return reply.code(404).send({ error: "homepage_media_not_found" })
    try {
      const result = await deleteHomepageMedia(deps.db(), { adminUserId: request.authPrincipal!.userId, slot: b.slot })
      return { result }
    } catch (error) {
      return dbFailure(request, reply, "homepage_media_delete", error)
    }
  })

  app.put("/v1/admin/homepage/hero-layout", { bodyLimit: LAYOUT_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const b = request.body
    if (!isObject(b) || Object.keys(b).length !== 2 || !isObject(b.rect) || typeof b.expectedRevision !== "number" || !Number.isInteger(b.expectedRevision)) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const result = await updateHeroLayout(deps.db(), { adminUserId: request.authPrincipal!.userId, rect: b.rect, expectedRevision: b.expectedRevision })
      return { result }
    } catch (error) {
      return dbFailure(request, reply, "homepage_hero_layout", error)
    }
  })
}

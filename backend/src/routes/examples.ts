import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import {
  createExample,
  deleteExample,
  getExample,
  listExamples,
  replaceExampleMedia,
  updateExample,
} from "@/lib/repositories/examples"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * EXAMPLES CMS (V0.1.53): metadata in PostgreSQL, image bytes in Storage.
 *
 *   GET    /v1/public/examples                 none        published examples, sort_order asc, newest first
 *   GET    /v1/admin/examples                  v2, admin   all
 *   GET    /v1/admin/examples/:id              v2, admin
 *   POST   /v1/admin/examples                  v3, admin   { id, kind, title, badge_label, description, media_url, is_published, sort_order }
 *   PATCH  /v1/admin/examples/:id              v3, admin   any of title, badge_label, description, kind, sort_order, is_published
 *   PUT    /v1/admin/examples/:id/media        v3, admin   { media_url } -> { example, previousMediaUrl }
 *   DELETE /v1/admin/examples/:id              v3, admin   -> the deleted row
 *
 * The caller is ONLY the principal; every write is one narrow trusted function
 * that re-checks the admin role and the field rules (and that an object key is
 * examples/<this id>/...). The public list never includes an unpublished row.
 */

const FORM_BODY_LIMIT = 16 * 1024
const MEDIA_BODY_LIMIT = 4096
const TINY_BODY_LIMIT = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELD_KEYS = new Set(["title", "badge_label", "description", "kind", "sort_order", "is_published"])
const CREATE_KEYS = ["id", "kind", "title", "badge_label", "description", "media_url", "is_published", "sort_order"]

function statusFor(token: string): number {
  if (token === "example_admin_forbidden") return 403
  if (token === "example_admin_not_found") return 404
  return 422
}

function dbFailure(request: FastifyRequest, reply: FastifyReply, operation: string, error: unknown) {
  if (error instanceof DbError && error.kind === "business" && error.businessCode?.startsWith("example_admin_")) {
    logEvent("info", "EXAMPLE_REFUSED", { requestId: request.id, operation, reason: error.businessCode })
    return reply.code(statusFor(error.businessCode)).send({ error: error.businessCode })
  }
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", "EXAMPLE_DB_FAILED", {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const idOf = (request: FastifyRequest): string | null => {
  const id = (request.params as { id?: string }).id
  return typeof id === "string" && UUID.test(id) ? id : null
}

export function registerExampleRoutes(app: FastifyInstance, deps: BackendDeps): void {
  const read = { preHandler: [requireAuth(deps), requireRole("admin", "super_admin")] }

  app.get("/v1/public/examples", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    if (Object.keys((request.query ?? {}) as object).length > 0) return reply.code(400).send({ error: "invalid_request" })
    try {
      return { examples: await listExamples(deps.db(), { publishedOnly: true }) }
    } catch (error) {
      return dbFailure(request, reply, "examples_public", error)
    }
  })

  app.get("/v1/admin/examples", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    try {
      return { examples: await listExamples(deps.db(), { publishedOnly: false }) }
    } catch (error) {
      return dbFailure(request, reply, "examples_admin_list", error)
    }
  })

  app.get("/v1/admin/examples/:id", read, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const id = idOf(request)
    if (!id) return reply.code(404).send({ error: "example_admin_not_found" })
    try {
      const example = await getExample(deps.db(), id)
      if (!example) return reply.code(404).send({ error: "example_admin_not_found" })
      return { example }
    } catch (error) {
      return dbFailure(request, reply, "examples_admin_get", error)
    }
  })

  app.post("/v1/admin/examples", { bodyLimit: FORM_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const b = request.body
    if (!isObject(b) || Object.keys(b).length !== CREATE_KEYS.length || CREATE_KEYS.some((k) => !(k in b)) ||
        typeof b.id !== "string" || !UUID.test(b.id) || typeof b.kind !== "string" || typeof b.title !== "string" ||
        typeof b.badge_label !== "string" || typeof b.description !== "string" || typeof b.media_url !== "string" ||
        typeof b.is_published !== "boolean" || typeof b.sort_order !== "number" || !Number.isInteger(b.sort_order)) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      const example = await createExample(deps.db(), {
        adminUserId: request.authPrincipal!.userId,
        id: b.id,
        kind: b.kind,
        title: b.title,
        badgeLabel: b.badge_label,
        description: b.description,
        mediaUrl: b.media_url,
        isPublished: b.is_published,
        sortOrder: b.sort_order,
      })
      return reply.code(201).send({ example })
    } catch (error) {
      return dbFailure(request, reply, "example_create", error)
    }
  })

  app.patch("/v1/admin/examples/:id", { bodyLimit: FORM_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const id = idOf(request)
    if (!id) return reply.code(404).send({ error: "example_admin_not_found" })
    const b = request.body
    if (!isObject(b) || Object.keys(b).length === 0 || Object.keys(b).some((k) => !FIELD_KEYS.has(k))) {
      return reply.code(400).send({ error: "invalid_request" })
    }
    try {
      return { example: await updateExample(deps.db(), { adminUserId: request.authPrincipal!.userId, id, fields: b }) }
    } catch (error) {
      return dbFailure(request, reply, "example_update", error)
    }
  })

  app.put("/v1/admin/examples/:id/media", { bodyLimit: MEDIA_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const id = idOf(request)
    if (!id) return reply.code(404).send({ error: "example_admin_not_found" })
    const b = request.body
    if (!isObject(b) || Object.keys(b).length !== 1 || typeof b.media_url !== "string") return reply.code(400).send({ error: "invalid_request" })
    try {
      const r = await replaceExampleMedia(deps.db(), { adminUserId: request.authPrincipal!.userId, id, mediaUrl: b.media_url })
      return { example: r.example, previousMediaUrl: r.previous_media_url }
    } catch (error) {
      return dbFailure(request, reply, "example_media", error)
    }
  })

  app.delete("/v1/admin/examples/:id", { bodyLimit: TINY_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "admin", "super_admin")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const id = idOf(request)
    if (!id) return reply.code(404).send({ error: "example_admin_not_found" })
    try {
      return { example: await deleteExample(deps.db(), { adminUserId: request.authPrincipal!.userId, id }) }
    } catch (error) {
      return dbFailure(request, reply, "example_delete", error)
    }
  })
}

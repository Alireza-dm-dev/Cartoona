import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { findParentProfileIdByUserId } from "@/lib/repositories/parent-profiles"
import {
  createParentRequest,
  findRequestBySubmissionKey,
  resolveCharacterId,
  type CreateParentRequestInput,
} from "@/lib/repositories/parent-requests"
import { mapRequestRpcError } from "@/lib/requests/request-rpc-error"
import type { BackendDeps } from "../app"
import { requireAuth, requireRole, requireWriteAuth } from "../plugins/auth"

/**
 * PARENT REQUEST SUBMISSION (V0.1.50): the first financial write on the new
 * architecture. Order + request rows + welcome-credit-or-candy spend + ledger
 * are ONE PostgreSQL transaction (create_parent_request_trusted).
 *
 *   POST /v1/parent/requests   v3 write assertion (body digest + nonce), parent only
 *     body exactly the keys of RequestBody below (no file BYTES: the Next BFF
 *     has already put the object in storage and sends only its key + MIME type)
 *     200 { orderId, type, status, candyCost, replayed, paymentSource }
 *
 *   GET  /v1/parent/requests/by-submission-key?submissionKey=<uuid>   v2 read, parent only
 *     200 { found: false }  |  { found: true, orderId, type, status, candyCost, paymentSource }
 *     Only the CALLER's order can be found (parent_id = the profile resolved from
 *     the assertion), so another parent's key is indistinguishable from an unused one.
 *
 *   400 { error: "invalid_request" }       unknown/missing key, wrong type, bad uuid, query on POST
 *   401 / 403 / 409                         requireAuth / requireWriteAuth (409 replayed_request = same assertion twice)
 *   402 { error: "INSUFFICIENT_CANDIES" }  and the other function refusals, as { error: <token> }
 *       (403 request_consent_required, 409 CANDY_WALLET_NOT_FOUND, 422 shape rules,
 *        503 CREATION_PRICING_UNAVAILABLE - all mean NOTHING was written)
 *   404 { error: "parent_profile_not_found" }
 *   422 { error: "character_unavailable" }
 *   503 { error: "service_unavailable" }   database failure: the outcome of a WRITE is unknown
 *
 * Who is paying is ONLY `request.authPrincipal` -> the profile resolved here.
 * The body carries no user id, profile id, role, price, credit amount, wallet
 * or order status; price and payment source are derived in the database.
 * `orderId` is minted by the Next BFF because the storage key embeds it; the
 * function and this route both require the file key to start with
 * `<caller user id>/<orderId>/`.
 *
 * Retry semantics: the SAME submissionKey returns the original order (replayed,
 * no second charge); a replay of the same ASSERTION is refused 409 by its nonce
 * before this handler runs. Nothing here retries. Every response is no-store.
 */

export const REQUESTS_PATH = "/v1/parent/requests"
export const REQUEST_BY_KEY_PATH = "/v1/parent/requests/by-submission-key"

/** Draft text is capped by the function (5000 chars each); Persian text is 2 bytes a char. */
const POST_BODY_LIMIT = 64 * 1024
const TEXT_MAX = 6_000
const SHORT_MAX = 400

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPES = new Set(["image", "video", "drawing_animation"])
const BODY_KEYS = new Set([
  "submissionKey", "orderId", "type", "title", "description", "character", "durationKey",
  "durationChoice", "videoScript", "videoStyle", "animationStyle", "charactersSpeak", "childName", "file",
])
const FILE_KEYS = new Set(["path", "mimeType", "originalFilename"])

interface ParsedBody {
  input: Omit<CreateParentRequestInput, "parentProfileId" | "characterId">
  character: string | null
}

function str(value: unknown, max: number): string | null | undefined {
  if (value === null) return null
  if (typeof value !== "string" || value.length > max) return undefined
  return value
}

function parseBody(body: unknown, userId: string): ParsedBody | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== BODY_KEYS.size || keys.some((k) => !BODY_KEYS.has(k))) return null

  if (typeof o.submissionKey !== "string" || !UUID.test(o.submissionKey)) return null
  if (typeof o.orderId !== "string" || !UUID.test(o.orderId)) return null
  if (typeof o.type !== "string" || !TYPES.has(o.type)) return null
  const title = str(o.title, SHORT_MAX)
  const description = str(o.description, TEXT_MAX)
  const character = str(o.character, 200)
  const durationKey = str(o.durationKey, 20)
  const durationChoice = str(o.durationChoice, 20)
  const videoScript = str(o.videoScript, TEXT_MAX)
  const videoStyle = str(o.videoStyle, SHORT_MAX)
  const animationStyle = str(o.animationStyle, SHORT_MAX)
  const childName = str(o.childName, SHORT_MAX)
  if ([title, description, character, durationKey, durationChoice, videoScript, videoStyle, animationStyle, childName].includes(undefined)) {
    return null
  }
  if (o.charactersSpeak !== null && typeof o.charactersSpeak !== "boolean") return null

  let filePath: string | null = null
  let fileMimeType: string | null = null
  let originalFilename: string | null = null
  if (o.file !== null) {
    if (typeof o.file !== "object" || Array.isArray(o.file)) return null
    const f = o.file as Record<string, unknown>
    const fk = Object.keys(f)
    if (fk.length !== FILE_KEYS.size || fk.some((k) => !FILE_KEYS.has(k))) return null
    if (typeof f.path !== "string" || f.path.length > 512 || typeof f.mimeType !== "string" || f.mimeType.length > 100) return null
    const name = str(f.originalFilename, 255)
    if (name === undefined) return null
    // The object must be in THIS caller's folder for THIS order, whatever the BFF says.
    if (!f.path.startsWith(`${userId}/${o.orderId.toLowerCase()}/`) && !f.path.startsWith(`${userId}/${o.orderId}/`)) return null
    filePath = f.path
    fileMimeType = f.mimeType
    originalFilename = name
  }

  return {
    character: character as string | null,
    input: {
      orderId: o.orderId,
      submissionKey: o.submissionKey,
      type: o.type as CreateParentRequestInput["type"],
      title: title as string | null,
      description: description as string | null,
      durationKey: durationKey as string | null,
      durationChoice: durationChoice as string | null,
      videoScript: videoScript as string | null,
      videoStyle: videoStyle as string | null,
      animationStyle: animationStyle as string | null,
      charactersSpeak: o.charactersSpeak as boolean | null,
      childName: childName as string | null,
      filePath,
      fileMimeType,
      originalFilename,
    },
  }
}

function hasQuery(request: FastifyRequest): boolean {
  return Object.keys((request.query ?? {}) as Record<string, unknown>).length > 0
}

function databaseFailure(request: FastifyRequest, reply: FastifyReply, event: string, operation: string, error: unknown) {
  if (!(error instanceof DbError) && !(error instanceof DbConfigError)) throw error
  logEvent("warn", event, {
    requestId: request.id,
    operation,
    subsystem: "database",
    errorCode: "DATABASE_UNAVAILABLE",
    reason: error instanceof DbError ? error.kind : "config",
  })
  return reply.code(503).send({ error: "service_unavailable" })
}

export function registerParentRequestRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.post(
    REQUESTS_PATH,
    { bodyLimit: POST_BODY_LIMIT, preHandler: [requireWriteAuth(deps, "parent")] },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const operation = "parent_request_create"
      const userId = request.authPrincipal!.userId
      const reject = (status: number, error: string, reason: string) => {
        logEvent("info", "REQUEST_WRITE_REJECTED", { requestId: request.id, operation, reason })
        return reply.code(status).send({ error })
      }
      if (hasQuery(request)) return reject(400, "invalid_request", "query")
      const parsed = parseBody(request.body, userId)
      if (!parsed) return reject(400, "invalid_request", "body")

      try {
        const db = deps.db()
        const parentProfileId = await findParentProfileIdByUserId(db, { userId })
        if (!parentProfileId) return reject(404, "parent_profile_not_found", "no_parent_profile")

        let characterId: string | null = null
        if (parsed.character !== null && parsed.character.trim().length > 0) {
          characterId = await resolveCharacterId(db, parsed.character)
          if (!characterId) return reject(422, "character_unavailable", "character_unavailable")
        }

        const created = await createParentRequest(db, { ...parsed.input, parentProfileId, characterId })
        logEvent("info", created.replayed ? "REQUEST_WRITE_REPLAYED" : "REQUEST_WRITE_COMPLETED", {
          requestId: request.id,
          operation,
          paymentSource: created.paymentSource,
        })
        return {
          orderId: created.orderId,
          type: created.type,
          status: created.status,
          candyCost: created.candyCost,
          replayed: created.replayed,
          paymentSource: created.paymentSource,
        }
      } catch (error) {
        if (error instanceof DbError && error.kind === "business" && error.businessCode) {
          // One of the function's own refusals: nothing was written. Only a
          // token this codebase knows is echoed; anything else is request_failed.
          const mapped = mapRequestRpcError(error.businessCode)
          logEvent(mapped.status >= 500 ? "warn" : "info", "REQUEST_WRITE_REFUSED", {
            requestId: request.id,
            operation,
            reason: mapped.code,
          })
          return reply.code(mapped.status).send({ error: mapped.code })
        }
        return databaseFailure(request, reply, "REQUEST_WRITE_FAILED", operation, error)
      }
    },
  )

  app.get(REQUEST_BY_KEY_PATH, { preHandler: [requireAuth(deps), requireRole("parent")] }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const operation = "parent_request_by_key"
    const invalid = () => {
      logEvent("info", "REQUEST_READ_REJECTED", { requestId: request.id, operation, reason: "invalid_request" })
      return reply.code(400).send({ error: "invalid_request" })
    }
    const query = (request.query ?? {}) as Record<string, unknown>
    const names = Object.keys(query)
    if (names.length !== 1 || names[0] !== "submissionKey") return invalid()
    const key = query.submissionKey
    if (typeof key !== "string" || !UUID.test(key)) return invalid()

    try {
      const db = deps.db()
      const parentProfileId = await findParentProfileIdByUserId(db, { userId: request.authPrincipal!.userId })
      if (!parentProfileId) {
        logEvent("info", "REQUEST_READ_REJECTED", { requestId: request.id, operation, reason: "no_parent_profile" })
        return reply.code(404).send({ error: "parent_profile_not_found" })
      }
      const found = await findRequestBySubmissionKey(db, { parentProfileId, submissionKey: key })
      return found ? { found: true, ...found } : { found: false }
    } catch (error) {
      return databaseFailure(request, reply, "REQUEST_READ_FAILED", operation, error)
    }
  })
}

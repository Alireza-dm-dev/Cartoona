import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { DbConfigError, DbError } from "@/lib/db/errors"
import { logEvent } from "@/lib/observability/logger"
import { routeLabel } from "../plugins/observability"

/**
 * Central error mapping. Response bodies are fixed codes - never an error
 * message, stack, SQL state or constraint name. The request id is already on
 * the response header (onRequest), so a client can quote it to support.
 *
 *  validation / malformed request (4xx from Fastify)  -> that 4xx, { error: "invalid_request" }
 *  DbError unavailable / timeout / config              -> 503, { error: "service_unavailable" }
 *  anything else                                       -> 500, { error: "internal_error" }
 */

export const INTERNAL_ERROR_BODY = { error: "internal_error" } as const
export const UNAVAILABLE_BODY = { error: "service_unavailable" } as const

const TRANSIENT = new Set(["unavailable", "query_timeout", "serialization_failure", "deadlock"])

function isClientError(error: FastifyError): boolean {
  return Boolean(error.validation) || (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500)
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store")

    if (isClientError(error)) {
      const status = error.validation ? 400 : (error.statusCode as number)
      logEvent("info", "REQUEST_REJECTED", {
        requestId: request.id,
        route: routeLabel(request),
        method: request.method,
        status,
        errorCode: "VALIDATION_ERROR",
      })
      return reply.code(status).send({ error: "invalid_request" })
    }

    // Repositories throw normalised errors already (lib/db/query.ts).
    const thrown: unknown = error
    const db = thrown instanceof DbError || thrown instanceof DbConfigError ? thrown : null

    if (db && (db instanceof DbConfigError || TRANSIENT.has(db.kind))) {
      logEvent("warn", "REQUEST_FAILED", {
        requestId: request.id,
        route: routeLabel(request),
        method: request.method,
        status: 503,
        subsystem: "database",
        errorCode: "DATABASE_UNAVAILABLE",
        reason: db instanceof DbConfigError ? "config" : db.kind,
      })
      return reply.code(503).send(UNAVAILABLE_BODY)
    }

    logEvent("error", "REQUEST_FAILED", {
      requestId: request.id,
      route: routeLabel(request),
      method: request.method,
      status: 500,
      subsystem: db ? "database" : "request",
      errorCode: "INTERNAL_ERROR",
      reason: db instanceof DbError ? db.kind : undefined,
    })
    return reply.code(500).send(INTERNAL_ERROR_BODY)
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return reply.code(404).send({ error: "not_found" })
  })
}

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest, RawServerDefault } from "fastify"
import type { IncomingMessage } from "node:http"
import { logEvent, type LogLevel } from "@/lib/observability/logger"
import { REQUEST_ID_HEADER, isSafeRequestId } from "@/lib/observability/request-id"

/**
 * Request ids, completion logs and baseline headers for every backend response.
 *
 * Reuses the Next app's provider-neutral logger and request-id rule, so both
 * processes emit the same allow-listed JSON lines (REQUEST_COMPLETED with
 * requestId, method, route TEMPLATE, status, durationMs). Nothing else from the
 * request - URL, query, headers, cookies, body - is ever passed to the logger,
 * and the logger would drop it anyway.
 */

/** Fastify `genReqId`: reuse a well-formed incoming X-Request-Id, else mint a UUID. */
export function requestIdFor(raw: IncomingMessage): string {
  const incoming = raw.headers["x-request-id"]
  return isSafeRequestId(incoming) ? incoming : randomUUID()
}

export function completionLevel(status: number): LogLevel {
  if (status >= 500) return status === 503 ? "warn" : "error"
  return "info"
}

/** "GET /v1/creation-pricing" - the route template, never the concrete URL. */
export function routeLabel(request: FastifyRequest): string | undefined {
  const template = request.routeOptions.url
  return template ? `${request.method} ${template}` : undefined
}

export function registerObservability(app: FastifyInstance<RawServerDefault>): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id)
    reply.header("X-Content-Type-Options", "nosniff")
  })

  app.addHook("onResponse", async (request, reply) => {
    const route = routeLabel(request)
    logEvent(completionLevel(reply.statusCode), "REQUEST_COMPLETED", {
      requestId: request.id,
      method: request.method,
      route,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      subsystem: "request",
      reason: route ? undefined : "route_not_found",
    })
  })
}

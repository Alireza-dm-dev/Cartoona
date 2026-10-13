import "server-only"
import { AsyncLocalStorage } from "node:async_hooks"
import { NextResponse } from "next/server"
import { logEvent, type LogLevel, type LogFields } from "./logger"
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id"
import { categorizeError } from "./errors"

interface RequestContext {
  requestId: string
  route: string
  method: string
}

const storage = new AsyncLocalStorage<RequestContext>()

/** The current request's id, if inside an instrumented handler. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId
}

/**
 * Log an event, automatically tagged with the current request's id / route /
 * method so deep helpers (storage, session checks) need no extra plumbing.
 * Outside a request it still logs, just without those tags.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const ctx = storage.getStore()
  logEvent(level, event, {
    requestId: ctx?.requestId,
    route: ctx?.route,
    method: ctx?.method,
    ...fields,
  })
}

const INTERNAL_ERROR_BODY = {
  error: "خطای داخلی رخ داد. لطفاً دوباره تلاش کنید.",
  code: "internal_error",
}

function withRequestIdHeader(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId)
    return response
  } catch {
    // Immutable headers (e.g. Response.redirect): rebuild with the header.
    const headers = new Headers(response.headers)
    headers.set(REQUEST_ID_HEADER, requestId)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

function completionLevel(status: number): LogLevel {
  if (status >= 500) return status === 503 ? "warn" : "error"
  return "info"
}

/**
 * Wrap a route handler with request-id, latency and outcome logging.
 *
 *  - REQUEST_COMPLETED for every response (status + durationMs).
 *  - REQUEST_FAILED, exactly once, if the handler throws; the client gets a
 *    generic 500 carrying the request id, never the error text or a stack.
 *    A thrown request does not also emit REQUEST_COMPLETED.
 *  - X-Request-Id is set on every response.
 *
 * `route` must be the route TEMPLATE (e.g. "POST /api/parent/orders/[orderId]/
 * final-media"), never a concrete URL, so ids never enter log cardinality.
 */
export function withObservability<A extends unknown[]>(
  route: string,
  handler: (request: Request, ...args: A) => Promise<Response> | Response,
): (request: Request, ...args: A) => Promise<Response> {
  return async (request, ...args) => {
    const start = performance.now()
    const requestId = resolveRequestId(request.headers)
    const method = request.method
    const ctx: RequestContext = { requestId, route, method }

    return storage.run(ctx, async () => {
      try {
        const response = await handler(request, ...args)
        logEvent(completionLevel(response.status), "REQUEST_COMPLETED", {
          requestId,
          route,
          method,
          status: response.status,
          durationMs: performance.now() - start,
        })
        return withRequestIdHeader(response, requestId)
      } catch (error) {
        logEvent("error", "REQUEST_FAILED", {
          requestId,
          route,
          method,
          status: 500,
          subsystem: "request",
          errorCode: categorizeError(error),
          durationMs: performance.now() - start,
        })
        return withRequestIdHeader(
          NextResponse.json(
            { ...INTERNAL_ERROR_BODY, requestId },
            { status: 500, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
          ),
          requestId,
        )
      }
    })
  }
}

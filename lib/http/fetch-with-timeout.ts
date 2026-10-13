/**
 * Provider-neutral fetch with a hard deadline.
 *
 * Bounds how long ONE network call may take - connection, response headers and
 * response body together - so a stalled backend becomes a fast, predictable
 * failure instead of a hung request.
 *
 * Deliberately NOT done here:
 *  - no retry. A timed-out write may or may not have been applied; replaying it
 *    is the caller's decision (order submission has its own idempotency key).
 *  - no knowledge of any backend. Callers pick the deadline.
 */

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`)
    this.name = "FetchTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export function isFetchTimeoutError(error: unknown): error is FetchTimeoutError {
  return error instanceof FetchTimeoutError
}

type FetchLike = typeof fetch

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  // Resolved per call (not captured at import) so Next's patched global fetch
  // and test doubles are always the one used.
  fetchImpl: FetchLike = (...args) => globalThis.fetch(...args),
): Promise<Response> {
  const controller = new AbortController()
  const callerSignal =
    init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined)

  let timedOut = false
  let finished = false
  // Set once the response body is being streamed, so a deadline that fires
  // mid-body fails the stream itself instead of relying on the transport to.
  let failBody: ((error: unknown) => void) | null = null

  const cleanup = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    callerSignal?.removeEventListener("abort", onCallerAbort)
  }

  const onCallerAbort = () => {
    cleanup()
    controller.abort(callerSignal?.reason)
  }

  const timer = setTimeout(() => {
    timedOut = true
    finished = true
    callerSignal?.removeEventListener("abort", onCallerAbort)
    controller.abort(new FetchTimeoutError(timeoutMs))
    failBody?.(new FetchTimeoutError(timeoutMs))
  }, timeoutMs)

  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort()
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true })
    }
  }

  let response: Response
  try {
    response = await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    cleanup()
    throw timedOut ? new FetchTimeoutError(timeoutMs) : error
  }

  const body = response.body
  if (!body) {
    cleanup()
    return response
  }

  // The deadline keeps running while the body is read, so a server that sends
  // headers and then stalls is bounded too. The timer is released as soon as
  // the body is finished, failed or cancelled.
  const reader = body.getReader()
  const guarded = new ReadableStream<Uint8Array>({
    start(streamController) {
      failBody = (error) => {
        streamController.error(error)
        reader.cancel(error).catch(() => {})
      }
    },
    async pull(streamController) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          cleanup()
          streamController.close()
        } else {
          streamController.enqueue(value)
        }
      } catch (error) {
        cleanup()
        try {
          streamController.error(timedOut ? new FetchTimeoutError(timeoutMs) : error)
        } catch {
          // already errored by the deadline
        }
      }
    },
    cancel(reason) {
      cleanup()
      return reader.cancel(reason)
    },
  })

  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Bind a deadline policy into a drop-in `fetch` replacement. */
export function createTimeoutFetch(
  resolveTimeoutMs: (input: RequestInfo | URL) => number,
  fetchImpl?: FetchLike,
): FetchLike {
  return (input, init) => fetchWithTimeout(input, init, resolveTimeoutMs(input), fetchImpl)
}

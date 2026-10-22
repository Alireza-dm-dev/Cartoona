/**
 * The only error the backend client throws. `kind` is a safe category; the
 * message is derived from it alone, so nothing a caller logs or returns can
 * contain the backend address, a fetch exception, a socket error or a response
 * body. The original error is deliberately NOT kept on `cause`.
 *
 *  not_configured    BACKEND_INTERNAL_URL / timeout missing or invalid
 *  timeout           the single attempt exceeded the deadline
 *  unavailable       connection refused/reset, DNS failure, redirect, any fetch failure
 *  bad_status        the backend answered with a non-2xx status (carried in `status`)
 *  invalid_response  2xx, but not the expected JSON (unparsable, too large, or rejected by the caller's validator)
 *
 * `outcomeUnknown` (V0.1.47, writes only): true when the request may have
 * reached the backend and the write may have COMMITTED although no usable
 * answer came back (timeout, reset, 5xx, unreadable 2xx). A caller must not
 * report such a write as "not saved"; only `not_configured` (never sent) and
 * an accepted 4xx answer are definite. Always false for reads.
 */
export type BackendErrorKind =
  | "not_configured"
  | "timeout"
  | "unavailable"
  | "bad_status"
  | "invalid_response"

export class BackendClientError extends Error {
  readonly kind: BackendErrorKind
  /** HTTP status for `bad_status`, otherwise null. */
  readonly status: number | null
  readonly outcomeUnknown: boolean

  constructor(kind: BackendErrorKind, status: number | null = null, outcomeUnknown = false) {
    super(`backend request failed: ${kind}`)
    this.name = "BackendClientError"
    this.kind = kind
    this.status = status
    this.outcomeUnknown = outcomeUnknown
  }
}

export function isBackendClientError(error: unknown): error is BackendClientError {
  return error instanceof BackendClientError
}

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

  constructor(kind: BackendErrorKind, status: number | null = null) {
    super(`backend request failed: ${kind}`)
    this.name = "BackendClientError"
    this.kind = kind
    this.status = status
  }
}

export function isBackendClientError(error: unknown): error is BackendClientError {
  return error instanceof BackendClientError
}

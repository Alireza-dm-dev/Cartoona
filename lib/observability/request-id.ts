export const REQUEST_ID_HEADER = "X-Request-Id"

// Conservative: 8-64 chars of [A-Za-z0-9._-]. Long enough for a UUID or a
// proxy-generated id, too narrow to carry markup, whitespace or log-injection
// characters, and bounded so a hostile header cannot bloat every log line.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/

export function isSafeRequestId(value: unknown): value is string {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value)
}

/** Reuse a well-formed incoming id; otherwise mint a fresh UUID. */
export function resolveRequestId(headers: Pick<Headers, "get">): string {
  const incoming = headers.get(REQUEST_ID_HEADER)
  return isSafeRequestId(incoming) ? incoming : crypto.randomUUID()
}

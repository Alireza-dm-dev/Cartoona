/**
 * The idempotency key for one logical creation submit attempt.
 *
 * A UUID the client mints once per logical submission and resends unchanged
 * on every retry of that same attempt. It is never derived from the draft's
 * content — two identical drafts submitted separately must be free to become
 * two different orders — and it is never free text: the server only accepts
 * the UUID shape, so nothing else can be smuggled through this field.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidSubmissionKey(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

import { isFetchTimeoutError } from "@/lib/http/fetch-with-timeout"
import type { Subsystem } from "./logger"

/**
 * Stable, safe failure categories. These - never raw Postgres / Supabase /
 * network messages - are what logs record and what any client-facing mapping
 * may build on.
 */
export const ERROR_CATEGORIES = [
  "AUTH_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

const TIMEOUT_TEXT = /timed out after \d+\s*ms|FetchTimeoutError/i

function field(error: unknown, key: "name" | "message" | "code" | "status"): unknown {
  return error !== null && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined
}

export function isTimeoutError(error: unknown): boolean {
  if (isFetchTimeoutError(error)) return true
  const name = field(error, "name")
  const message = field(error, "message")
  return (
    name === "FetchTimeoutError" ||
    name === "TimeoutError" ||
    (typeof message === "string" && TIMEOUT_TEXT.test(message))
  )
}

/**
 * Classify any thrown value or Supabase-style `{ message }` error. Reads the
 * error only to choose a category; none of its text is ever returned.
 */
export function categorizeError(error: unknown, subsystem: Subsystem = "request"): ErrorCategory {
  if (isTimeoutError(error)) return "REQUEST_TIMEOUT"

  const status = field(error, "status")
  const code = field(error, "code")
  if (status === 429 || code === "over_request_rate_limit" || code === "over_email_send_rate_limit") {
    return "RATE_LIMITED"
  }

  switch (subsystem) {
    case "auth":
      return "AUTH_UNAVAILABLE"
    case "database":
      return "DATABASE_UNAVAILABLE"
    case "storage":
      return "STORAGE_UNAVAILABLE"
    default:
      return "INTERNAL_ERROR"
  }
}

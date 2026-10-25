import "server-only"

import { NextResponse } from "next/server"
import { log } from "@/lib/observability/request-context"

/**
 * Browser -> Next CSRF protection for authenticated JSON writes (V0.1.48).
 *
 * One helper for every browser-facing Next write route that acts on the
 * session cookie. Call it FIRST in the handler, before reading the body or
 * verifying the session: a rejected request does no work.
 *
 *   const rejected = rejectUnsafeBrowserWrite(request)
 *   if (rejected) return rejected
 *
 * Rules, for POST/PUT/PATCH/DELETE (GET/HEAD/OPTIONS pass untouched):
 *
 *   1. Content-Type must be application/json, optionally with
 *      `charset=utf-8` and nothing else. A form post
 *      (application/x-www-form-urlencoded, multipart/form-data) or text/plain
 *      - the three types a cross-site page can send without a CORS
 *      preflight - is refused.                                   415 unsupported_media_type
 *   2. Sec-Fetch-Site, when the browser sends it, must be `same-origin`.
 *      `same-site` (a sibling subdomain), `cross-site` and `none` (typed
 *      URL / bookmark - never how a write is made) are refused.   403 csrf_rejected
 *   3. Origin is REQUIRED and must equal, exactly, one configured application
 *      origin. Every current browser sends Origin on a POST/PUT/PATCH/DELETE,
 *      same-origin fetch included, so a missing Origin is not a browser
 *      write: refused. `null`, a malformed value, or one with a path,
 *      credentials or a trailing slash is refused.               403 csrf_rejected
 *
 * Sec-Fetch-Site alone is not trusted (older browsers omit it); Origin alone
 * would be enough, the fetch-metadata check is a second, independent signal.
 *
 * The expected origin is CONFIGURED, never derived from the request: Host,
 * X-Forwarded-Host, X-Forwarded-Proto and Referer are not read, so a proxy
 * that forwards a client-supplied host header cannot widen the allow-list.
 *
 *   CARTOONA_APP_ORIGIN   the public origin(s) of the Next app, comma-separated,
 *                         e.g. https://cartoona.ir. Server-only, read per
 *                         request (not NEXT_PUBLIC_*, which is baked at build).
 *                         Unset: http://localhost:3000 and http://127.0.0.1:3000
 *                         outside production; in production every write is
 *                         refused (503 csrf_not_configured) - fail closed.
 *
 * SameSite=Lax on the Supabase session cookie stays as defence in depth; it is
 * not the control (same-site subdomains and older browsers are outside it).
 *
 * Not for: GET routes, and NOT for the Next -> Fastify hop: that request is
 * server-to-server and is protected by the v3 internal assertion (body digest
 * + nonce). The backend never sees browser headers.
 */

export type BrowserWriteRejection =
  | { status: 415; code: "unsupported_media_type"; reason: "content_type" }
  | { status: 403; code: "csrf_rejected"; reason: "origin_missing" | "origin_malformed" | "origin_mismatch" | "fetch_site" }
  | { status: 503; code: "csrf_not_configured"; reason: "config" }
  | { status: 503; code: "write_freeze"; reason: "freeze" }

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const DEV_DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

type Env = Record<string, string | undefined>

/** `scheme://host[:port]` exactly as URL#origin prints it, or null. */
function canonicalOrigin(value: string): string | null {
  if (value === "" || value === "null" || value.length > 255) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  // URL#origin drops path, query, credentials and a trailing slash; requiring
  // the raw value to equal it refuses all of those instead of normalizing them.
  return url.origin === value ? value : null
}

/**
 * Cutover write freeze (V0.1.54). CARTOONA_WRITE_FREEZE=1 (exactly "1", read per
 * request) makes every browser-facing business write answer 503 write_freeze
 * with Retry-After, before any body is read or session verified. Reads, sign-in
 * and the Next -> Fastify hop are untouched; the payment webhook route checks
 * it too so the provider retries later. An operator tool for the cutover window
 * only - see docs/PRODUCTION_CUTOVER.md. Unset in every normal deployment.
 */
export function isWriteFrozen(env: Env = process.env): boolean {
  return env.CARTOONA_WRITE_FREEZE === "1"
}

/** The configured origins; null when misconfigured (or unset in production). */
export function expectedOrigins(env: Env = process.env): string[] | null {
  const raw = env.CARTOONA_APP_ORIGIN?.trim()
  if (!raw) return env.NODE_ENV === "production" ? null : DEV_DEFAULT_ORIGINS
  const origins = raw.split(",").map((s) => s.trim())
  if (origins.some((o) => canonicalOrigin(o) === null)) return null
  return origins
}

/** application/json with at most a utf-8 charset parameter. */
export function isJsonContentType(header: string | null): boolean {
  if (!header) return false
  const [type, ...params] = header.split(";")
  if (type.trim().toLowerCase() !== "application/json") return false
  return params.every((p) => {
    const [name, value, ...rest] = p.split("=")
    if (rest.length > 0 || value === undefined) return false
    return name.trim().toLowerCase() === "charset" && value.trim().replace(/^"(.*)"$/, "$1").toLowerCase() === "utf-8"
  })
}

/**
 * multipart/form-data with the boundary parameter (V0.1.50, POST /api/requests
 * only: the one browser write that carries a file). The type itself is one a
 * cross-site form can send without a preflight, so unlike JSON it proves
 * nothing; the Origin and Sec-Fetch-Site rules below are what protect it.
 */
export function isMultipartContentType(header: string | null): boolean {
  if (!header) return false
  const [type, ...params] = header.split(";")
  if (type.trim().toLowerCase() !== "multipart/form-data") return false
  return params.length > 0 && params.every((p) => /^\s*(boundary|charset)\s*=/i.test(p))
}

export type BrowserWriteBody = "json" | "multipart"

/** Pure decision; null means the request may proceed. */
export function checkBrowserWrite(request: Request, env: Env = process.env, body: BrowserWriteBody = "json"): BrowserWriteRejection | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null
  if (isWriteFrozen(env)) return { status: 503, code: "write_freeze", reason: "freeze" }

  const contentType = request.headers.get("content-type")
  if (!(body === "multipart" ? isMultipartContentType(contentType) : isJsonContentType(contentType))) {
    return { status: 415, code: "unsupported_media_type", reason: "content_type" }
  }

  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== "same-origin") {
    return { status: 403, code: "csrf_rejected", reason: "fetch_site" }
  }

  const allowed = expectedOrigins(env)
  if (!allowed) return { status: 503, code: "csrf_not_configured", reason: "config" }

  const origin = request.headers.get("origin")
  if (origin === null) return { status: 403, code: "csrf_rejected", reason: "origin_missing" }
  const canonical = canonicalOrigin(origin)
  if (canonical === null) return { status: 403, code: "csrf_rejected", reason: "origin_malformed" }
  if (!allowed.includes(canonical)) return { status: 403, code: "csrf_rejected", reason: "origin_mismatch" }
  return null
}

const MESSAGES: Record<BrowserWriteRejection["code"], string> = {
  unsupported_media_type: "فرمت درخواست باید JSON باشد.",
  csrf_rejected: "درخواست از مبدأ نامعتبر.",
  csrf_not_configured: "این عملیات موقتاً در دسترس نیست.",
  write_freeze: "سیستم در حال به‌روزرسانی است. لطفاً چند دقیقه بعد دوباره تلاش کنید.",
}

/**
 * The route-handler form: a ready JSON response (no-store) when the request
 * must be refused, otherwise null. Rejections are logged by category only,
 * never with the Origin value.
 */
export function rejectUnsafeBrowserWrite(request: Request, env: Env = process.env, body: BrowserWriteBody = "json"): NextResponse | null {
  const rejection = checkBrowserWrite(request, env, body)
  if (!rejection) return null
  log(rejection.status === 503 && rejection.code !== "write_freeze" ? "error" : "info", "CSRF_REJECTED", {
    subsystem: "request",
    status: rejection.status,
    errorCode: rejection.code,
    reason: rejection.reason,
  })
  return NextResponse.json(
    {
      error: rejection.code === "unsupported_media_type" && body === "multipart" ? "فرمت درخواست باید multipart/form-data باشد." : MESSAGES[rejection.code],
      code: rejection.code,
    },
    {
      status: rejection.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(rejection.code === "write_freeze" ? { "Retry-After": "120" } : {}),
      },
    },
  )
}

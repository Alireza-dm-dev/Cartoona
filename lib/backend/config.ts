/**
 * Configuration of the server-to-server client that calls the Fastify backend
 * (V0.1.41). Read from the environment at CALL time, never at import or build
 * time, so `next build` needs neither variable.
 *
 *  BACKEND_INTERNAL_URL          required. The backend's INTERNAL address:
 *                                  Docker:        http://backend:4000
 *                                  Next on Mac:   http://127.0.0.1:4000
 *                                Server-side only: it is never NEXT_PUBLIC_*,
 *                                never sent to the browser. In production the
 *                                backend must be reachable only over a private
 *                                network.
 *  BACKEND_REQUEST_TIMEOUT_MS    optional, default 3000, range 250-15000. One
 *                                request, one attempt, this long at most.
 *
 * Every error message below names a variable and never its value, so a
 * misconfiguration cannot print the address.
 */

export const BACKEND_TIMEOUT_DEFAULT_MS = 3000
export const BACKEND_TIMEOUT_MIN_MS = 250
export const BACKEND_TIMEOUT_MAX_MS = 15_000

export interface BackendClientConfig {
  /** Origin only, e.g. "http://backend:4000" (no path, no trailing slash). */
  baseUrl: string
  timeoutMs: number
}

export class BackendConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackendConfigError"
  }
}

type Env = Record<string, string | undefined>

function parseBaseUrl(raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) throw new BackendConfigError("BACKEND_INTERNAL_URL is not set.")

  // Checked on the raw text too: the URL parser silently normalises an empty
  // "?" or "#" away, and a userinfo "@" is never legitimate here.
  if (/[?#@\s\\]/.test(value)) {
    throw new BackendConfigError("BACKEND_INTERNAL_URL must be a plain http(s)://host[:port] address.")
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BackendConfigError("BACKEND_INTERNAL_URL is not a valid URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BackendConfigError("BACKEND_INTERNAL_URL must use http or https.")
  }
  if (!url.hostname) throw new BackendConfigError("BACKEND_INTERNAL_URL must include a host.")
  if (url.username || url.password) {
    throw new BackendConfigError("BACKEND_INTERNAL_URL must not contain credentials.")
  }
  if (url.search || url.hash || url.pathname !== "/") {
    throw new BackendConfigError("BACKEND_INTERNAL_URL must not contain a path, query or fragment.")
  }
  return url.origin
}

function parseTimeout(raw: string | undefined): number {
  const value = raw?.trim()
  if (value === undefined || value === "") return BACKEND_TIMEOUT_DEFAULT_MS
  const message = `BACKEND_REQUEST_TIMEOUT_MS must be an integer between ${BACKEND_TIMEOUT_MIN_MS} and ${BACKEND_TIMEOUT_MAX_MS}.`
  if (!/^\d{1,6}$/.test(value)) throw new BackendConfigError(message)
  const ms = Number.parseInt(value, 10)
  if (ms < BACKEND_TIMEOUT_MIN_MS || ms > BACKEND_TIMEOUT_MAX_MS) throw new BackendConfigError(message)
  return ms
}

export function readBackendClientConfig(env: Env = process.env): BackendClientConfig {
  return {
    baseUrl: parseBaseUrl(env.BACKEND_INTERNAL_URL),
    timeoutMs: parseTimeout(env.BACKEND_REQUEST_TIMEOUT_MS),
  }
}

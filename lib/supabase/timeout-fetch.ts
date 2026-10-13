import { createTimeoutFetch } from "@/lib/http/fetch-with-timeout"

/**
 * Deadlines for server-side Supabase traffic (Auth, PostgREST, RPC, Storage).
 *
 * Measured stalls were ~10 s connection hangs and occasional ~30 s hangs; normal
 * calls finish in well under a second. 10 s sits above the connection stall's
 * typical recovery without letting a request hang for 30 s. Storage moves file
 * bytes (up to the 10 MiB upload cap) so it gets a longer budget.
 */
export const SUPABASE_REQUEST_TIMEOUT_MS = 10_000
export const SUPABASE_STORAGE_TIMEOUT_MS = 25_000

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

export function resolveSupabaseTimeoutMs(input: RequestInfo | URL): number {
  return requestUrl(input).includes("/storage/v1/")
    ? SUPABASE_STORAGE_TIMEOUT_MS
    : SUPABASE_REQUEST_TIMEOUT_MS
}

/**
 * `global.fetch` for server, admin and middleware Supabase clients.
 *
 * Not used by the browser client: Auth token refresh runs there, and aborting
 * a refresh whose response was lost can strand a rotated refresh token.
 */
export const supabaseTimeoutFetch = createTimeoutFetch(resolveSupabaseTimeoutMs)

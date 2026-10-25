import "server-only"
import { createClient } from "@supabase/supabase-js"
import { supabaseTimeoutFetch } from "./timeout-fetch"
import type { SupabaseStorageServiceClient } from "./types"

/**
 * The SERVICE-CREDENTIAL client (SUPABASE_SECRET_KEY), for Supabase STORAGE bytes
 * only: uploads, removals and signed URLs for objects whose access PostgreSQL has
 * already authorized (final deliverables, homepage media, examples media).
 *
 * V0.1.53: the return type exposes `storage` and nothing else. It cannot query a
 * table, call an RPC or use the Auth admin API; a static guard also pins that it
 * is imported only by the lib/storage modules. The name is historical.
 */
export function createAdminSupabaseClient(): SupabaseStorageServiceClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL")
  if (!secret) throw new Error("Missing SUPABASE_SECRET_KEY")

  return createClient(url, secret, {
    global: { fetch: supabaseTimeoutFetch },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })
}

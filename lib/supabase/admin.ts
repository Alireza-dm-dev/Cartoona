import "server-only"
import { createClient } from "@supabase/supabase-js"
import { supabaseTimeoutFetch } from "./timeout-fetch"
import { disablePostgrestRetries } from "./postgrest-retry"

export function createAdminSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL")
  if (!secret) throw new Error("Missing SUPABASE_SECRET_KEY")

  const client = createClient(url, secret, {
    global: { fetch: supabaseTimeoutFetch },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  return disablePostgrestRetries(client)
}

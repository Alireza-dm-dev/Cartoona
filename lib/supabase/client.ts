import { createBrowserClient } from '@supabase/ssr'
import { getSupabaseEnv } from './env'
import type { SupabaseSessionClient } from './types'

/** The browser's Supabase client: Auth only in practice (sign-in, OTP, session). It has no `.from()` / `.rpc()` type (V0.1.53). */
export function createBrowserSupabaseClient(): SupabaseSessionClient {
  const env = getSupabaseEnv()

  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}

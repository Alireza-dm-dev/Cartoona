import { createBrowserClient } from '@supabase/ssr'
import { getSupabaseEnv } from './env'

export function createBrowserSupabaseClient() {
  const env = getSupabaseEnv()

  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}

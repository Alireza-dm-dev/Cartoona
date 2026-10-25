import { createServerClient } from '@supabase/ssr'
import { getSupabaseEnv } from './env'
import { cookies } from 'next/headers'
import { supabaseTimeoutFetch } from './timeout-fetch'
import type { SupabaseSessionClient } from './types'

/**
 * The request's session client: Auth and Storage only (V0.1.53; the type has no
 * `.from()` / `.rpc()`, there is no Supabase database access left to make).
 *
 * `options.fetch` replaces the default per-request deadline fetch. Used by the
 * auth adapter to impose ONE deadline on a whole identity verification, which
 * can otherwise span several refresh attempts (lib/auth/auth-deadline.ts).
 */
export async function createServerSupabaseClient(options: { fetch?: typeof fetch } = {}): Promise<SupabaseSessionClient> {
  const env = getSupabaseEnv()
  const cookieStore = await cookies()

  const client = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { fetch: options.fetch ?? supabaseTimeoutFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // Called from a Server Component — can be ignored if middleware
          // handles session refresh.
        }
      },
    },
  })

  return client
}

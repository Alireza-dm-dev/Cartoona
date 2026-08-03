import { createServerClient } from '@supabase/ssr'
import { getSupabaseEnv } from './env'
import { cookies } from 'next/headers'

export async function createServerSupabaseClient() {
  const env = getSupabaseEnv()
  const cookieStore = await cookies()

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
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
}

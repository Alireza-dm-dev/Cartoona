import "server-only"

import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAuthDeadlineFetch, withDeadline } from "./auth-deadline"

const SIGN_OUT_DEADLINE_MS = 2_000

/**
 * A definite end of session (expired / invalidated) clears the session
 * cookies, as the pre-cutover routes did. Bounded; if the provider does not
 * answer, the caller's 401 still stands. Never called for an outage.
 */
export async function endParentSession(): Promise<void> {
  try {
    const supabase = await createServerSupabaseClient({ fetch: createAuthDeadlineFetch(Date.now() + SIGN_OUT_DEADLINE_MS) })
    await withDeadline(supabase.auth.signOut({ scope: "local" }), SIGN_OUT_DEADLINE_MS)
  } catch {
    // Fail closed: the 401 stands either way.
  }
}

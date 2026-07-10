/**
 * Supabase server client — NOT CONNECTED.
 *
 * Supabase packages are not installed. This client will throw if called.
 *
 * TODO: When implementing auth, install @supabase/supabase-js and @supabase/ssr.
 * Then create a real server client using createServerClient from @supabase/ssr.
 * Use NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 * Never expose SUPABASE_SERVICE_ROLE_KEY to the client bundle.
 */

export function createServerClient(): never {
  throw new Error(
    "Supabase server client is not connected. Install @supabase/supabase-js and @supabase/ssr before calling createServerClient()."
  );
}

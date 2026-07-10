/**
 * Supabase browser client — NOT CONNECTED.
 *
 * Supabase packages are not installed. This client will throw if called.
 *
 * TODO: When implementing auth, install @supabase/supabase-js and @supabase/ssr.
 * Then create a real browser client using createBrowserClient from @supabase/ssr.
 * Use NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY env vars.
 * Do NOT expose SUPABASE_SERVICE_ROLE_KEY on the client.
 */

export function createClient(): never {
  throw new Error(
    "Supabase client is not connected. Install @supabase/supabase-js and @supabase/ssr before calling createClient()."
  );
}

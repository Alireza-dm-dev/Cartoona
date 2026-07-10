/**
 * Supabase admin client — NOT CONNECTED.
 *
 * Supabase packages are not installed. This client will throw if called.
 *
 * TODO: When implementing admin features, install @supabase/supabase-js.
 * Then create an admin client using createClient with the service role key.
 * This must only be used in server/admin contexts — never expose to the client bundle.
 * Use SUPABASE_SERVICE_ROLE_KEY env var.
 */

export function createAdminClient(): never {
  throw new Error(
    "Supabase admin client is not connected. Install @supabase/supabase-js before calling createAdminClient()."
  );
}

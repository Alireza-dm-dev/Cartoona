import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Narrow client types (V0.1.53). After this release Supabase is Auth and Storage
 * only: every business row lives in PostgreSQL behind the backend. The helpers in
 * this directory therefore return clients whose TYPE has no `.from()` and no
 * `.rpc()`, so a Supabase database read or write cannot be written by accident
 * (it does not compile), on top of the static guard that scans the runtime tree
 * (tests/unit/zero-supabase-db-static.test.ts).
 */

/** A session-scoped client: Auth (verify, refresh, sign out, password) and Storage (signed URLs, source files). */
export type SupabaseSessionClient = Pick<SupabaseClient, "auth" | "storage">

/** The service-credential client: Storage bytes ONLY. No Auth admin, no table, no RPC. */
export type SupabaseStorageServiceClient = Pick<SupabaseClient, "storage">

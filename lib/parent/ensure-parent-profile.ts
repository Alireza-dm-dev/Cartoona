import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Creation of the single `parent_profiles` row a parent is allowed to own.
 *
 * Used by signup completion. Until V0.1.48 the consent route used it too (and
 * created a missing profile on consent); consent now lives in PostgreSQL, see
 * lib/parent/consent/. Writes go through the caller's user-scoped client, so the `parent_profiles_insert_own` RLS policy — not this code — is
 * what ultimately binds a profile to its own `auth.uid()`.
 *
 * Consent is never written here, not even its initial value: the row is
 * created with the column defaults (not consented, no time). Consent itself
 * is read and written only through the backend since V0.1.48.
 *
 * The name is optional. Phone + OTP signup never collects one, so a missing
 * name is an ordinary outcome rather than a failure; the column is nullable
 * and the account UI falls back to "حساب والد" at display time. No placeholder
 * is ever written.
 */

export type EnsureParentProfileResult =
  | { ok: true; created: boolean; profileId: string }
  | { ok: false; reason: "write_failed" };

/** Postgres unique-violation; two concurrent inserts race to the same row. */
const UNIQUE_VIOLATION = "23505";

interface ExistingProfile {
  id: string;
}

async function readProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ row: ExistingProfile | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { row: null, failed: true };
  return { row: (data as ExistingProfile | null) ?? null, failed: false };
}

/**
 * Ensures exactly one profile exists for `userId`, creating it only if absent.
 *
 * Idempotent by construction: the row is looked up first, the UNIQUE constraint
 * on `user_id` backstops a concurrent insert, and a unique violation is
 * resolved by re-reading the winning row rather than surfacing an error. Retry
 * of a signup therefore returns the same profile instead of a second one.
 */
export async function ensureParentProfile(
  supabase: SupabaseClient,
  params: { userId: string; fullName?: string | null },
): Promise<EnsureParentProfileResult> {
  // Null, absent and whitespace all mean the same thing: no name was given.
  // They are never turned into an empty string, which the column rejects.
  const trimmed = (params.fullName || "").trim();
  const fullName = trimmed.length > 0 ? trimmed : null;

  const existing = await readProfile(supabase, params.userId);
  if (existing.failed) return { ok: false, reason: "write_failed" };

  if (existing.row) {
    // An existing name is never touched here. A parent who has a name keeps
    // it even if a later caller happens to pass nothing.
    return { ok: true, created: false, profileId: existing.row.id };
  }

  const { data, error } = await supabase
    .from("parent_profiles")
    .insert({
      user_id: params.userId,
      full_name: fullName,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code !== UNIQUE_VIOLATION) return { ok: false, reason: "write_failed" };

    // Someone else inserted first; adopt their row rather than failing.
    const raced = await readProfile(supabase, params.userId);
    if (raced.failed || !raced.row) return { ok: false, reason: "write_failed" };
    return { ok: true, created: false, profileId: raced.row.id };
  }

  if (!data?.id) return { ok: false, reason: "write_failed" };
  return { ok: true, created: true, profileId: data.id };
}

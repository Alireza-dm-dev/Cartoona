import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Creation of the single `parent_profiles` row a parent is allowed to own.
 *
 * Shared by signup completion and consent recording so both paths converge on
 * one row with one set of rules. Writes go through the caller's user-scoped
 * client, so the `parent_profiles_insert_own` RLS policy — not this code — is
 * what ultimately binds a profile to its own `auth.uid()`.
 */

export type EnsureParentProfileResult =
  | { ok: true; created: boolean; profileId: string }
  | { ok: false; reason: "missing_name" | "write_failed" };

/**
 * `grant` records consent as given; `preserve` leaves an existing verdict
 * untouched and starts a new profile un-consented. Signup uses `preserve` so
 * completing signup can never be mistaken for granting consent.
 */
export type ConsentIntent = "grant" | "preserve";

/** Postgres unique-violation; two concurrent inserts race to the same row. */
const UNIQUE_VIOLATION = "23505";

interface ExistingProfile {
  id: string;
  consent_granted: boolean;
}

async function readProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ row: ExistingProfile | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("parent_profiles")
    .select("id, consent_granted")
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
  params: { userId: string; fullName: string; consent: ConsentIntent },
): Promise<EnsureParentProfileResult> {
  const fullName = (params.fullName || "").trim();
  if (!fullName) return { ok: false, reason: "missing_name" };

  const existing = await readProfile(supabase, params.userId);
  if (existing.failed) return { ok: false, reason: "write_failed" };

  if (existing.row) {
    // Consent is only ever moved forward, never revoked by a repeated call.
    if (params.consent === "grant" && !existing.row.consent_granted) {
      const { error } = await supabase
        .from("parent_profiles")
        .update({
          consent_granted: true,
          consent_granted_at: new Date().toISOString(),
        })
        .eq("user_id", params.userId);

      if (error) return { ok: false, reason: "write_failed" };
    }
    return { ok: true, created: false, profileId: existing.row.id };
  }

  const granted = params.consent === "grant";
  const { data, error } = await supabase
    .from("parent_profiles")
    .insert({
      user_id: params.userId,
      full_name: fullName,
      consent_granted: granted,
      consent_granted_at: granted ? new Date().toISOString() : null,
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

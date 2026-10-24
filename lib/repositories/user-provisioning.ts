import { runQuery } from "@/lib/db/query"
import type { Queryable } from "@/lib/db/types"
import { isValidSubject } from "@/lib/identity/types"

/**
 * Provisioning of a Supabase-authenticated parent in Cartoona's PostgreSQL
 * (V0.1.49): users + user_identities + parent_profiles (+ the profile
 * triggers' referral code, wallet and welcome credits), in one transaction,
 * through provision_supabase_parent_identity (migration 0015), the one
 * provisioning privilege the app role has.
 *
 * The ONLY input is the provider subject from a verified assertion. There is
 * no user id (it IS the subject), no role (always parent), no profile id, no
 * name and no amount: nothing a caller could use to point the account at
 * someone else's rows. Idempotent and serialized per subject in the database;
 * see the migration for the outcome semantics.
 */

export type ProvisioningOutcome =
  | "created"
  | "existing"
  | "profile_created"
  | "identity_backfilled"
  | "identity_conflict"
  | "account_deleted"
  | "not_parent"

const OUTCOMES: ReadonlySet<string> = new Set<ProvisioningOutcome>([
  "created",
  "existing",
  "profile_created",
  "identity_backfilled",
  "identity_conflict",
  "account_deleted",
  "not_parent",
])

/** Outcomes after which the account is complete and usable. */
export const PROVISIONED_OUTCOMES: ReadonlySet<ProvisioningOutcome> = new Set([
  "created",
  "existing",
  "profile_created",
  "identity_backfilled",
])

const PROVISION = `SELECT public.provision_supabase_parent_identity($1::uuid) AS outcome`

export async function provisionSupabaseParent(
  db: Queryable,
  input: { providerSubject: string },
): Promise<ProvisioningOutcome> {
  if (!isValidSubject("supabase", input.providerSubject)) {
    throw new TypeError("provisionSupabaseParent: invalid subject")
  }
  const rows = await runQuery<{ outcome: unknown }>(db, PROVISION, [input.providerSubject])
  const outcome = rows[0]?.outcome
  // The function always returns one of its documented words; anything else
  // means a schema this build does not know - refuse rather than guess.
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    throw new TypeError("provisionSupabaseParent: unexpected outcome")
  }
  return outcome as ProvisioningOutcome
}

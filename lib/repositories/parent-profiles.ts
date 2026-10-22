import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

const SELECT_PROFILE_ID = `
  SELECT p.id
  FROM public.parent_profiles p
  WHERE p.user_id = $1`;

/**
 * The parent profile id owned by a user - the `P` every parent-scoped
 * repository takes. Replaces `parent_profiles.select("id").eq("user_id", U)`
 * from ParentRequestContext. Null when the user has no profile (`user_id` is
 * unique, so there is at most one).
 */
export async function findParentProfileIdByUserId(
  db: Queryable,
  input: { userId: string },
): Promise<string | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ id: string }>(db, SELECT_PROFILE_ID, [userId]);
  return rows[0]?.id ?? null;
}

const SELECT_DISPLAY = `
  SELECT p.full_name
  FROM public.parent_profiles p
  WHERE p.user_id = $1`;

/**
 * What the parent UI shows of a user's own profile (V0.1.46): the name only.
 * Null when the user has no profile; `fullName` is null when the profile has
 * no name. No id, consent, referral code or timestamp leaves this function.
 */
export async function getParentProfileDisplay(
  db: Queryable,
  input: { userId: string },
): Promise<{ fullName: string | null } | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ full_name: string | null }>(db, SELECT_DISPLAY, [userId]);
  const row = rows[0];
  if (!row) return null;
  return { fullName: typeof row.full_name === "string" ? row.full_name : null };
}

const UPDATE_NAME = `
  UPDATE public.parent_profiles
  SET full_name = $2, updated_at = now()
  WHERE user_id = $1
  RETURNING full_name`;

/**
 * The first application WRITE on plain PostgreSQL (V0.1.47): set the user's
 * own display name. `fullName` must already be validated and normalized
 * (lib/parent/profile-name.ts); null clears it. Ownership is the predicate:
 * only the row whose user_id is the authenticated user can change. Null when
 * that user has no profile (nothing was written).
 *
 * The app role holds UPDATE on (full_name, updated_at) only (migration 0013).
 * Repeating the same value is harmless: the row ends in the same state.
 */
export async function updateParentProfileName(
  db: Queryable,
  input: { userId: string; fullName: string | null },
): Promise<{ fullName: string | null } | null> {
  const userId = requireUuid(input.userId, "userId");
  if (input.fullName !== null && typeof input.fullName !== "string") throw new TypeError("fullName must be a string or null");
  const rows = await runQuery<{ full_name: string | null }>(db, UPDATE_NAME, [userId, input.fullName]);
  const row = rows[0];
  if (!row) return null;
  return { fullName: typeof row.full_name === "string" ? row.full_name : null };
}

/** A parent's consent as stored (V0.1.48). `grantedAt` is an ISO timestamp, null while not granted. */
export interface ParentConsentState {
  consentGranted: boolean;
  consentGrantedAt: string | null;
}

function toConsentState(row: { consent_granted: unknown; consent_granted_at: unknown }): ParentConsentState {
  if (typeof row.consent_granted !== "boolean") throw new TypeError("consent_granted must be boolean");
  const at = row.consent_granted_at;
  return {
    consentGranted: row.consent_granted,
    consentGrantedAt: at instanceof Date ? at.toISOString() : typeof at === "string" ? new Date(at).toISOString() : null,
  };
}

const SELECT_CONSENT = `
  SELECT p.consent_granted, p.consent_granted_at
  FROM public.parent_profiles p
  WHERE p.user_id = $1`;

/**
 * The signed-in user's consent (V0.1.48): the flag and its time, nothing else
 * from the profile. Null when the user has no profile - the caller decides
 * what that means (every consent gate treats it as "not consented").
 */
export async function getParentConsentState(
  db: Queryable,
  input: { userId: string },
): Promise<ParentConsentState | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ consent_granted: unknown; consent_granted_at: unknown }>(db, SELECT_CONSENT, [userId]);
  return rows[0] ? toConsentState(rows[0]) : null;
}

const RECORD_CONSENT = `
  SELECT consent_granted, consent_granted_at
  FROM public.record_parent_consent_trusted($1)`;

/**
 * Records the user's consent (V0.1.48) through the one function the app role
 * may execute for it (migration 0014): one-way, the first grant's time is
 * kept, never inserts a profile. Returns the stored state; null when the user
 * has no profile (nothing was written). Repeating it is harmless.
 */
export async function recordParentConsent(
  db: Queryable,
  input: { userId: string },
): Promise<ParentConsentState | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ consent_granted: unknown; consent_granted_at: unknown }>(db, RECORD_CONSENT, [userId]);
  return rows[0] ? toConsentState(rows[0]) : null;
}

import { IDENTITY_PROVIDER } from "./mapping"
import { DataCopyError } from "./safety"
import type { Queryable } from "./validate"

/**
 * user_identities backfill (V0.1.44): for every user in the target,
 *
 *   provider = 'supabase', provider_subject = users.id::text, user_id = users.id
 *
 * Copied users keep id = their Supabase auth user UUID, so the subject is the
 * user's own id and the mapping is deterministic. The row id is derived too
 * (md5 of a fixed prefix + user id), and created_at is the user's created_at,
 * so two runs over the same users produce identical rows. Deleted users are
 * included: the row keeps the historical link, and the backend denies them on
 * users.deleted_at, not on a missing identity.
 *
 * Rules:
 *  - (supabase, subject, same user) already present  -> no-op
 *  - (supabase, subject) points at a different user  -> refuse, write nothing
 *  - the user has a supabase identity with another subject -> refuse. The
 *    schema does not forbid several identities per provider, but nothing in
 *    Cartoona creates one, so for a migrated user it can only be an error.
 *
 * Runs inside the caller's transaction and never overwrites or deletes a row.
 */

const CONFLICTS = `
  SELECT 'subject ' || i.provider_subject || ' is mapped to user ' || i.user_id || ', expected ' || u.id AS ref
  FROM public.user_identities i JOIN public.users u ON i.provider_subject = u.id::text
  WHERE i.provider = $1 AND i.user_id <> u.id
  UNION ALL
  SELECT 'user ' || u.id || ' already has ' || $1 || ' subject ' || i.provider_subject AS ref
  FROM public.user_identities i JOIN public.users u ON i.user_id = u.id
  WHERE i.provider = $1 AND i.provider_subject <> u.id::text
  ORDER BY 1`

const INSERT_MISSING = `
  INSERT INTO public.user_identities (id, user_id, provider, provider_subject, created_at)
  SELECT md5('cartoona-identity:' || $1 || ':' || u.id::text)::uuid, u.id, $1, u.id::text, u.created_at
  FROM public.users u
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_identities i WHERE i.provider = $1 AND i.provider_subject = u.id::text AND i.user_id = u.id)
  ORDER BY u.id`

const MISSING_AFTER = `
  SELECT count(*)::int AS n FROM public.users u
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_identities i WHERE i.provider = $1 AND i.provider_subject = u.id::text AND i.user_id = u.id)`

export async function backfillSupabaseIdentities(db: Queryable): Promise<{ inserted: number; alreadyPresent: number }> {
  // Nothing may add users or identities while the mapping is checked and written.
  await db.query("LOCK TABLE public.users, public.user_identities IN SHARE ROW EXCLUSIVE MODE")

  const conflicts = await db.query<{ ref: string }>(CONFLICTS, [IDENTITY_PROVIDER])
  if (conflicts.rows.length > 0) {
    throw new DataCopyError(
      "identity_conflict",
      `user_identities has ${conflicts.rows.length} conflicting '${IDENTITY_PROVIDER}' mapping(s). Nothing was written; resolve them by hand.`,
      { exitCode: 4, details: conflicts.rows.slice(0, 20).map((r) => r.ref) },
    )
  }

  const before = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_identities WHERE provider = $1`, [IDENTITY_PROVIDER])
  // No ON CONFLICT: a unique violation here would mean the state changed under
  // the lock, and must fail loudly rather than be skipped.
  const inserted = await db.query(INSERT_MISSING, [IDENTITY_PROVIDER])
  const missing = await db.query<{ n: number }>(MISSING_AFTER, [IDENTITY_PROVIDER])
  if ((missing.rows[0]?.n ?? 0) !== 0) {
    throw new DataCopyError("identity_conflict", "identity backfill left users without a mapping", { exitCode: 4 })
  }
  return { inserted: inserted.rowCount ?? 0, alreadyPresent: before.rows[0]?.n ?? 0 }
}

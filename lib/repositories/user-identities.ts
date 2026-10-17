import { runQuery } from "@/lib/db/query"
import type { Queryable } from "@/lib/db/types"
import { isIdentityProvider, isPrincipalRole, isValidSubject, type IdentityProvider, type PrincipalRole } from "@/lib/identity/types"

export interface ResolvedUserIdentity {
  userId: string
  role: PrincipalRole
  /** Soft-deleted Cartoona account: the caller must refuse it. */
  deleted: boolean
}

const RESOLVE_IDENTITY = `
  SELECT u.id AS user_id, u.role, (u.deleted_at IS NOT NULL) AS deleted
  FROM public.user_identities ui
  JOIN public.users u ON u.id = ui.user_id
  WHERE ui.provider = $1
    AND ui.provider_subject = $2`

/**
 * (provider, provider_subject) -> Cartoona user and role, from PostgreSQL only.
 *
 * Read-only by design: a verified external identity that is not linked returns
 * null, and nothing is created on the fly. Linking happens only through an
 * explicit bootstrap (signup) or the migration backfill (docs/AUTH_ARCHITECTURE.md).
 * The role comes from `public.users`; nothing about it is taken from the
 * provider or the caller. Unique (provider, provider_subject) means at most one
 * row. Returns no email, phone, names or profile data.
 *
 * Inputs come from a VERIFIED assertion, but are validated again here; an
 * invalid provider or subject throws instead of querying.
 */
export async function resolveUserIdentity(
  db: Queryable,
  input: { provider: IdentityProvider; providerSubject: string },
): Promise<ResolvedUserIdentity | null> {
  if (!isIdentityProvider(input.provider) || !isValidSubject(input.provider, input.providerSubject)) {
    throw new TypeError("resolveUserIdentity: invalid identity")
  }
  const rows = await runQuery<{ user_id: string; role: unknown; deleted: boolean }>(db, RESOLVE_IDENTITY, [
    input.provider,
    input.providerSubject,
  ])
  const row = rows[0]
  if (!row) return null
  // The users_role_check constraint makes this impossible today; refuse rather
  // than guess if a newer schema ever adds a role this build does not know.
  if (!isPrincipalRole(row.role)) return null
  return { userId: row.user_id, role: row.role, deleted: row.deleted }
}

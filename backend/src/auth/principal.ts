/**
 * The authentication boundary (V0.1.40: declared, NOT implemented).
 *
 * No backend route is authenticated yet. When one is, the flow is:
 *
 *   request -> AuthAdapter.verify(request)   (cookie/JWT/session: provider-specific)
 *           -> AuthPrincipal                 (verified, provider-neutral)
 *           -> service / repository          (explicit ids, e.g. { parentProfileId })
 *
 * Rules that hold from the first authenticated route on:
 *  - A principal is produced ONLY by an AuthAdapter that verified a credential.
 *    A user id, role or profile id sent by the browser (body, query, header) is
 *    never trusted and never becomes a principal.
 *  - Routes pass the principal's ids to repositories explicitly; repositories
 *    never look up "the current user" themselves (see lib/repositories/actor.ts).
 *  - The adapter is the only provider-specific piece. Supabase Auth can sit
 *    behind it during migration, its user id mapped to `users.id` through
 *    `user_identities`; replacing the provider replaces the adapter only.
 */

export type PrincipalRole = "parent" | "admin" | "super_admin"

export interface AuthPrincipal {
  /** `public.users.id`: the plain-PostgreSQL user, never a provider id. */
  userId: string
  role: PrincipalRole
}

/** Minimal request view an adapter needs; deliberately not a Fastify type. */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>
}

export type AuthResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; reason: "unauthenticated" | "auth_unavailable" }

export interface AuthAdapter {
  verify(request: AuthRequest): Promise<AuthResult>
}

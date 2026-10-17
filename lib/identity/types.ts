/**
 * Provider-neutral identity types (V0.1.42).
 *
 * Shared by the Next.js auth adapter, the Fastify backend and tests. No
 * Fastify, Next.js or Supabase types here, and nothing provider-specific beyond
 * the provider NAME.
 *
 *   ExternalIdentity   who an identity provider says the caller is:
 *                      (provider, subject). Never a Cartoona id.
 *   VerifiedIdentity   an ExternalIdentity a server-side adapter has just
 *                      verified with the provider. Only an adapter makes one.
 *   AuthPrincipal      the Cartoona user the backend resolved that identity to
 *                      through `user_identities`. Its role comes from
 *                      `public.users`, never from the provider or the caller.
 */

/** Identity providers Cartoona accepts. Adding one is a deliberate code change. */
export const IDENTITY_PROVIDERS = ["supabase"] as const
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number]

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  return typeof value === "string" && (IDENTITY_PROVIDERS as readonly string[]).includes(value)
}

export interface ExternalIdentity {
  provider: IdentityProvider
  /** The provider's stable id for the account (Supabase: the auth user UUID). */
  subject: string
}

declare const verified: unique symbol

/**
 * Branded so that a value built from request data cannot be passed where a
 * verified identity is required without going through an adapter's
 * `toVerifiedIdentity` (or an explicit, greppable cast in tests).
 */
export type VerifiedIdentity = ExternalIdentity & { readonly [verified]: true }

export function toVerifiedIdentity(identity: ExternalIdentity): VerifiedIdentity {
  return identity as VerifiedIdentity
}

export type PrincipalRole = "parent" | "admin" | "super_admin"

export function isPrincipalRole(value: unknown): value is PrincipalRole {
  return value === "parent" || value === "admin" || value === "super_admin"
}

export interface AuthPrincipal {
  /** `public.users.id`: the Cartoona user, never a provider id. */
  userId: string
  role: PrincipalRole
}

/** Subject shape per provider; anything else is rejected before any lookup. */
const SUBJECT_FORMAT: Record<IdentityProvider, RegExp> = {
  supabase: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
}

export function isValidSubject(provider: IdentityProvider, subject: unknown): subject is string {
  return typeof subject === "string" && SUBJECT_FORMAT[provider].test(subject)
}

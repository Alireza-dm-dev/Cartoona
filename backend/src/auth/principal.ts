/**
 * The authentication boundary of the backend (V0.1.40 types, implemented V0.1.42).
 *
 *   Next.js server: Supabase session --verified--> VerifiedIdentity
 *     --signed internal assertion (lib/identity/assertion.ts)-->
 *   Fastify: verify assertion --> (provider, subject)
 *     --user_identities (PostgreSQL)--> AuthPrincipal { userId, role }
 *     --> route --> repositories with explicit ids (principal.userId -> parentProfileId)
 *
 * Rules:
 *  - The ONLY input is the `X-Cartoona-Internal-Auth` header. X-User-Id,
 *    X-Role, cookies, bearer tokens, query or body identity are never read.
 *  - The backend never calls the identity provider; it trusts the Next server's
 *    signature (shared secret), and nothing else.
 *  - The role comes from `public.users`, never from the assertion.
 *  - Provider-specific code lives only in the Next adapter
 *    (lib/auth/supabase-identity-adapter.ts); replacing Supabase Auth replaces
 *    that adapter and the `provider` value, not this backend.
 *
 * The types are shared with Next and tests from lib/identity/types.ts.
 */
export type { AuthPrincipal, ExternalIdentity, PrincipalRole, VerifiedIdentity } from "@/lib/identity/types"

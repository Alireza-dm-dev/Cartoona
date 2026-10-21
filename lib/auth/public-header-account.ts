import "server-only";

import { cache } from "react";
import { fetchParentProfile } from "@/lib/parent/account/backend-account";
import { withDeadline } from "./auth-deadline";
import { toParentAccountSummary, type ParentAccountSummary } from "./parent-account";
import { verifySupabaseIdentity, type SupabaseIdentityDeps } from "./supabase-identity-adapter";

/**
 * The one entry point every public header uses to learn who is signed in.
 *
 * The marketing layout, the homepage and the creation layout all call this, so
 * the public site resolves the session in exactly one place and the three
 * headers cannot disagree about it. Any failure degrades to the anonymous
 * header rather than taking a public page down.
 *
 * V0.1.46: the parent's name is read from PostgreSQL through the backend:
 *
 *   session cookie -> verifySupabaseIdentity (provider verifies; amr; 30 days)
 *     -> signed v2 assertion -> Fastify GET /v1/parent/profile
 *     -> requireAuth + requireRole("parent") -> parent_profiles.full_name
 *
 * No Supabase table is read. Admins, super_admins, deleted or unlinked
 * accounts, and expired or invalidated sessions get the anonymous header
 * (the backend answers 401/403). A parent without a profile is greeted
 * neutrally. Nothing is ever signed out from here: a public page only renders.
 *
 * Reading the session cookie opts the calling route out of static rendering.
 * That is deliberate — it is what lets the correct header ship in the first
 * HTML, with no logged-out flash.
 *
 * Bounded (V0.1.42): the whole lookup — session verification, any token
 * refresh, the backend read — gets ONE deadline. Past it the header renders
 * anonymous. A public page never waits on auth longer than this.
 *
 * Request-local reuse (V0.1.46): the homepage renders inside the marketing
 * layout and both ask for the account. React's `cache` makes that ONE lookup
 * per server render. It is scoped to the render: nothing is shared across
 * requests or visitors.
 */
export const PUBLIC_HEADER_AUTH_DEADLINE_MS = 2_500;

export interface PublicHeaderAccountDeps {
  deadlineMs?: number;
  /** Builds the auth client with the deadline fetch; tests inject a stubbed provider. */
  createClient?: SupabaseIdentityDeps["createClient"];
}

async function lookup(deadlineMs: number, deps: PublicHeaderAccountDeps): Promise<ParentAccountSummary | null> {
  const verification = await verifySupabaseIdentity({ deadlineMs, createClient: deps.createClient });
  if (!verification.ok) return null;
  const profile = await fetchParentProfile(verification.context);
  if (profile.ok) return toParentAccountSummary(profile.value.fullName);
  return profile.reason === "no_parent_profile" ? toParentAccountSummary(null) : null;
}

async function resolve(deps: PublicHeaderAccountDeps): Promise<ParentAccountSummary | null> {
  const deadlineMs = deps.deadlineMs ?? PUBLIC_HEADER_AUTH_DEADLINE_MS;
  try {
    return await withDeadline(lookup(deadlineMs, deps), deadlineMs);
  } catch {
    return null;
  }
}

const resolveForThisRender = cache(() => resolve({}));

export function getPublicHeaderAccount(deps?: PublicHeaderAccountDeps): Promise<ParentAccountSummary | null> {
  return deps ? resolve(deps) : resolveForThisRender();
}

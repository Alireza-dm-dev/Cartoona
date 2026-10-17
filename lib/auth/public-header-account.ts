import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createDeadlineFetch, withDeadline } from "./auth-deadline";
import { getParentAccountSummary, type ParentAccountSummary } from "./parent-account";

/**
 * The one entry point every public header uses to learn who is signed in.
 *
 * The marketing layout, the homepage and the creation layout all call this, so
 * the public site resolves the session in exactly one place and the three
 * headers cannot disagree about it. A configuration failure degrades to the
 * anonymous header rather than taking a public page down.
 *
 * Kept apart from `parent-account.ts` because this is the only part that reads
 * cookies: the decision logic next door stays importable without a request.
 *
 * Reading the session cookie opts the calling route out of static rendering.
 * That is deliberate — it is what lets the correct header ship in the first
 * HTML, with no logged-out flash.
 *
 * Bounded (V0.1.42): the whole lookup — session verification, any token
 * refresh, the role and name reads — gets ONE deadline. Before, a visitor whose
 * cookie held an expired access token waited ~26 s on every public page when
 * the auth provider was unreachable (auth-js retries the refresh inside a 30 s
 * budget). Past the deadline the header renders anonymous, exactly as for any
 * other lookup failure. Nothing is signed out: see auth-deadline.ts for why the
 * session survives. A public page never waits on auth longer than this.
 */
export const PUBLIC_HEADER_AUTH_DEADLINE_MS = 2_500;

export interface PublicHeaderAccountDeps {
  deadlineMs?: number;
  /** Builds the client with the deadline fetch; tests inject a stubbed provider. */
  createClient?: (fetchImpl: typeof fetch) => Promise<SupabaseClient>;
}

export async function getPublicHeaderAccount(
  deps: PublicHeaderAccountDeps = {},
): Promise<ParentAccountSummary | null> {
  const deadlineMs = deps.deadlineMs ?? PUBLIC_HEADER_AUTH_DEADLINE_MS;
  const fetchImpl = createDeadlineFetch(Date.now() + deadlineMs);
  const createClient =
    deps.createClient ?? ((impl: typeof fetch) => createServerSupabaseClient({ fetch: impl }));
  try {
    const supabase = await createClient(fetchImpl);
    return await withDeadline(getParentAccountSummary(supabase), deadlineMs);
  } catch {
    return null;
  }
}

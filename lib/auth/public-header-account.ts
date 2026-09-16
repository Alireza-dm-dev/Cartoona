import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
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
 */
export async function getPublicHeaderAccount(): Promise<ParentAccountSummary | null> {
  try {
    const supabase = await createServerSupabaseClient();
    return await getParentAccountSummary(supabase);
  } catch {
    return null;
  }
}

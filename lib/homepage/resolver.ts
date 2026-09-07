import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveHomepageWith } from "@/lib/homepage/resolve-core";

export type {
  ResolvedHomepage,
  ResolvedHomepageMedia,
  ResolveSources,
  MediaSource,
} from "@/lib/homepage/resolve-core";

/**
 * The single authoritative homepage CMS read. Public components never query
 * Supabase themselves - they receive resolved props from the page module.
 *
 * All decision logic lives in `resolve-core`, which carries no `server-only`
 * marker and is therefore unit-testable against an injected client.
 */
export async function getResolvedHomepage() {
  const supabase = await createServerSupabaseClient();
  return resolveHomepageWith(supabase);
}

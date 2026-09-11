import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  resolveHomepageContent,
  type HomepageContentResult,
  type HomepageContentSource,
} from "@/lib/homepage/content-resolution";
import { HOMEPAGE_SINGLETON_KEY } from "@/lib/homepage/types";

export type { HomepageContentResult, HomepageContentSource };

/**
 * Reads the homepage singleton. Server-only: it depends on
 * `createServerSupabaseClient`, which reads request cookies.
 *
 * All decision-making lives in `resolveHomepageContent`, which is pure and
 * tested directly. This function is the thin IO shell: it performs the query,
 * hands the outcome to the resolver, and logs whatever the resolver flagged.
 * It never throws and never lets a database error reach the browser - the
 * homepage falls back to the bundled defaults instead.
 *
 * Not wired to the homepage components yet; that is a later phase.
 */
export async function getHomepageContent(): Promise<HomepageContentResult> {
  let outcome;

  try {
    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase
      .from("homepage_content")
      .select("content_json, revision")
      .eq("singleton_key", HOMEPAGE_SINGLETON_KEY)
      .maybeSingle();

    outcome = resolveHomepageContent({
      row: data ? { content_json: data.content_json, revision: data.revision } : null,
      readFailed: Boolean(error),
    });
  } catch {
    outcome = resolveHomepageContent({ row: null, readFailed: true });
  }

  const { diagnostic, ...result } = outcome;
  if (diagnostic) {
    const log = diagnostic.level === "error" ? console.error : console.warn;
    log(`[homepage] ${diagnostic.message}`, {
      singletonKey: HOMEPAGE_SINGLETON_KEY,
      ...(diagnostic.fields ? { fields: diagnostic.fields } : {}),
    });
  }

  return result;
}

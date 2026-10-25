import "server-only";
import {
  resolveHomepageContent,
  type HomepageContentResult,
  type HomepageContentSource,
} from "@/lib/homepage/content-resolution";
import { fetchHomepageData } from "@/lib/homepage/backend-homepage";
import { HOMEPAGE_SINGLETON_KEY } from "@/lib/homepage/types";

export type { HomepageContentResult, HomepageContentSource };

/**
 * Reads the homepage singleton through the backend (V0.1.53; PostgreSQL, no
 * Supabase table). All decision-making lives in `resolveHomepageContent`, which
 * is pure and tested directly. This function is the thin IO shell: it fetches,
 * hands the outcome to the resolver, and logs whatever the resolver flagged. It
 * never throws and never lets a failure reach the browser - the homepage falls
 * back to the bundled defaults instead.
 */
export async function getHomepageContent(): Promise<HomepageContentResult> {
  const data = await fetchHomepageData();
  const outcome = resolveHomepageContent({
    row: data?.content ? { content_json: data.content.contentJson, revision: data.content.revision } : null,
    readFailed: data === null,
  });

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

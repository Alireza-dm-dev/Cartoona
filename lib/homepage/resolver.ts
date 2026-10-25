import "server-only";

import { fetchHomepageData } from "@/lib/homepage/backend-homepage";
import { resolveHomepageFromData } from "@/lib/homepage/resolve-core";
import { homepageMediaPublicUrl } from "@/lib/storage/homepage-media";

export type {
  ResolvedHomepage,
  ResolvedHomepageMedia,
  ResolveSources,
  MediaSource,
} from "@/lib/homepage/resolve-core";

/**
 * The single authoritative homepage CMS read (V0.1.53: PostgreSQL through the
 * backend, anonymous, one request; it used to be three Supabase table reads).
 * Public components never fetch themselves - they receive resolved props from
 * the page module. If the backend cannot answer, the committed defaults render
 * (content, local media files, default TV rectangle): the public page is never
 * blank and never throws.
 *
 * All decision logic lives in `resolve-core`, which carries no `server-only`
 * marker and is unit-testable with plain data. Storage is touched only to build
 * the public URL of an object key (pure string building, no request).
 */
export async function getResolvedHomepage() {
  const data = await fetchHomepageData();
  return resolveHomepageFromData(data, homepageMediaPublicUrl);
}

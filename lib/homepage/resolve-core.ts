/**
 * Pure homepage resolution core.
 *
 * Deliberately free of `server-only` and of Next.js request APIs so the whole
 * read/compose path is unit-testable with an injected Supabase client.
 * `lib/homepage/resolver.ts` is the thin server wrapper that supplies the real
 * client; everything that decides *what the page renders* lives here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HomepageContent } from "@/lib/homepage/types";
import { HOMEPAGE_SINGLETON_KEY } from "@/lib/homepage/types";
import type { HeroTvRect } from "@/lib/homepage/hero-layout";
import { DEFAULT_TV_RECT, validateHeroTvRect } from "@/lib/homepage/hero-layout";
import {
  resolveHomepageContent,
  type HomepageContentRow,
  type HomepageContentSource,
} from "@/lib/homepage/content-resolution";
import {
  HOMEPAGE_MEDIA_SLOT_SPECS,
  HOMEPAGE_MEDIA_SLOT_VALUES,
  type HomepageMediaSlot,
} from "@/lib/homepage/media-slots";
import {
  queryAdminHomepageMedia,
  type AdminMediaOverview,
} from "@/lib/admin/homepage/media-service";

/** Every canonical dot-keyed slot resolves to exactly one safe URL. */
export type ResolvedHomepageMedia = Record<HomepageMediaSlot, string>;

export type MediaSource = "database" | "local-fallback";

/**
 * Local fallback map, derived from the slot specs rather than retyped. There is
 * one definition of "the file currently shipped for this slot"
 * (`HOMEPAGE_MEDIA_SLOT_SPECS[slot].currentPublicPath`) and this is it, so the
 * fallback can never drift from the committed asset or invent a slot key.
 */
export const LOCAL_MEDIA_FALLBACK: ResolvedHomepageMedia = Object.fromEntries(
  HOMEPAGE_MEDIA_SLOT_VALUES.map((slot) => [
    slot,
    HOMEPAGE_MEDIA_SLOT_SPECS[slot].currentPublicPath,
  ]),
) as ResolvedHomepageMedia;

/** Resolved homepage data served to public pages. */
export interface ResolvedHomepage {
  content: HomepageContent;
  media: ResolvedHomepageMedia;
  heroLayout: HeroTvRect;
  sources: ResolveSources;
}

/** Diagnostics for each resolved piece - server-side observability only. */
export interface ResolveSources {
  content: HomepageContentSource;
  heroLayout: "database" | "default";
  mediaPerSlot: Record<HomepageMediaSlot, MediaSource>;
}

/** The empty overview used when the media read is unavailable entirely. */
const EMPTY_MEDIA_OVERVIEW: AdminMediaOverview = {
  slots: [],
  heroLayout: null,
  sharedBackground: false,
};

/**
 * A resolved media URL may only be a rooted local path or an https URL, and may
 * never contain a traversal segment or whitespace. A malformed `storage_path`
 * that survived into `getPublicUrl` shows up here as a traversal or a non-https
 * scheme, and is rejected in favour of the committed local asset.
 */
export function isSafeMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (url.length === 0) return false;
  if (url !== value) return false;
  if (/\s/.test(url)) return false;
  if (url.includes("..")) return false;
  if (url.startsWith("//")) return false;
  if (url.startsWith("/")) return true;
  return url.startsWith("https://");
}

/**
 * Picks one safe URL per slot. Slots are resolved independently: a CMS override
 * on one slot never changes another, and hero/sections backgrounds stay separate
 * even though they ship the same file.
 */
export function composeMedia(overview: AdminMediaOverview): {
  media: ResolvedHomepageMedia;
  mediaPerSlot: Record<HomepageMediaSlot, MediaSource>;
} {
  const bySlot = new Map(overview.slots.map((slot) => [slot.slotKey, slot]));

  const media = {} as ResolvedHomepageMedia;
  const mediaPerSlot = {} as Record<HomepageMediaSlot, MediaSource>;

  for (const slot of HOMEPAGE_MEDIA_SLOT_VALUES) {
    const fallback = LOCAL_MEDIA_FALLBACK[slot];
    const candidate = bySlot.get(slot)?.previewUrl;

    if (isSafeMediaUrl(candidate) && candidate !== fallback) {
      media[slot] = candidate;
      mediaPerSlot[slot] = "database";
    } else {
      media[slot] = fallback;
      mediaPerSlot[slot] = "local-fallback";
    }
  }

  return { media, mediaPerSlot };
}

/** Validated CMS rect when one exists, otherwise the committed default. */
export function composeHeroLayout(overview: AdminMediaOverview): {
  heroLayout: HeroTvRect;
  source: "database" | "default";
} {
  const stored = overview.heroLayout?.rect;
  if (stored && validateHeroTvRect(stored).length === 0) {
    const { x, y, width, height } = stored;
    return { heroLayout: { x, y, width, height }, source: "database" };
  }
  return { heroLayout: DEFAULT_TV_RECT, source: "default" };
}

/**
 * Reads the single content row. A missing table or a missing row and a
 * transport failure are reported distinctly, so the caller can tell a fresh
 * environment from a broken one.
 */
export async function readHomepageContentRow(supabase: SupabaseClient): Promise<{
  row: HomepageContentRow | null;
  readFailed: boolean;
}> {
  try {
    const { data, error } = await supabase
      .from("homepage_content")
      .select("content_json, revision")
      .eq("singleton_key", HOMEPAGE_SINGLETON_KEY)
      .maybeSingle();

    if (error) return { row: null, readFailed: true };
    if (!data) return { row: null, readFailed: false };

    return {
      row: { content_json: data.content_json, revision: data.revision },
      readFailed: false,
    };
  } catch {
    // Transport-level failure only: `error` above already covers a missing table.
    return { row: null, readFailed: true };
  }
}

/**
 * Resolves the full homepage from a live client. Three bounded reads:
 * `homepage_content`, `homepage_media_assets`, `homepage_hero_layout`.
 * Never throws - every failure degrades to the committed defaults.
 */
export async function resolveHomepageWith(
  supabase: SupabaseClient,
): Promise<ResolvedHomepage> {
  const { row, readFailed } = await readHomepageContentRow(supabase);
  const contentResult = resolveHomepageContent({ row, readFailed });

  let overview: AdminMediaOverview;
  try {
    overview = await queryAdminHomepageMedia(supabase);
  } catch {
    overview = EMPTY_MEDIA_OVERVIEW;
  }

  const { media, mediaPerSlot } = composeMedia(overview);
  const { heroLayout, source: heroLayoutSource } = composeHeroLayout(overview);

  return {
    content: contentResult.content,
    media,
    heroLayout,
    sources: {
      content: contentResult.source,
      heroLayout: heroLayoutSource,
      mediaPerSlot,
    },
  };
}

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createPrivateSignedUrls } from "@/lib/storage/private-signed-url";
import {
  GALLERY_DEFAULT_PAGE_SIZE,
  clampGalleryPageSize,
  decodeGalleryCursor,
  encodeGalleryCursor,
} from "./pagination";
import type { ParentGalleryMedia, ParentGalleryResult } from "./types";

/**
 * Columns the gallery reads. Listed explicitly rather than with `*` so a later
 * column on `media_assets` cannot widen what the parent sees by accident.
 * `file_url` is read because a signed URL cannot be built without it, and it
 * is consumed inside this module only — `toGalleryMedia` never copies it into
 * the read model.
 */
const GALLERY_COLUMNS =
  "id, file_url, mime_type, created_at, original_filename, order_id";

/** Untrusted shape of one row as it arrives from PostgREST. */
export interface RawGalleryRow {
  id: unknown;
  file_url: unknown;
  mime_type: unknown;
  created_at: unknown;
  original_filename: unknown;
}

/**
 * Narrow one database row to the parent read model.
 *
 * Exported for unit testing, which is why it takes a plain object and the
 * already-signed URL rather than a query builder. Returns null when the row
 * cannot be presented safely, so a newer database degrades by hiding a row
 * rather than leaking an internal value into the UI.
 *
 * The storage path is an input here and is deliberately not an output: there
 * is no field on `ParentGalleryMedia` that could carry it to the browser.
 */
export function toGalleryMedia(
  row: RawGalleryRow,
  signedUrl: string | null,
): ParentGalleryMedia | null {
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.created_at !== "string" || row.created_at.length === 0) return null;

  const mimeType = typeof row.mime_type === "string" ? row.mime_type : null;
  const rawLabel =
    typeof row.original_filename === "string" ? row.original_filename.trim() : "";

  return {
    id: row.id,
    mimeType,
    uploadedAt: row.created_at,
    signedUrl,
    isImage: mimeType?.startsWith("image/") ?? false,
    label: rawLabel.length > 0 ? rawLabel.slice(0, 120) : null,
  };
}

/**
 * One page of the signed-in parent's source assets, newest first.
 *
 * Ownership is enforced twice over. The query joins `orders` and filters on
 * the resolved `parent_id`, so another parent's row never reaches this
 * process; row level security applies the same rule independently on the anon
 * key. `asset_role`/`type` restrict the result to parent-uploaded source
 * media, which is what keeps delivered output out of this library.
 *
 * Paginated by keyset on (created_at DESC, id DESC): one extra row is read to
 * learn whether another page exists, and only the page itself is signed - in
 * a single batched storage call rather than one call per asset.
 */
export async function getParentGalleryMedia(
  supabase: SupabaseClient,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ParentGalleryResult> {
  const pageSize = clampGalleryPageSize(options.limit ?? GALLERY_DEFAULT_PAGE_SIZE);

  let cursor = null;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
    cursor = decodeGalleryCursor(options.cursor);
    if (!cursor) return { ok: false, reason: "invalid_cursor" };
  }

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return { ok: false, reason: "unauthenticated" };

  const { data: profile, error: profileError } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) return { ok: false, reason: "read_failed" };
  if (!profile?.id) return { ok: false, reason: "no_parent_profile" };

  let query = supabase
    .from("media_assets")
    .select(`${GALLERY_COLUMNS}, orders!inner(parent_id)`)
    .eq("orders.parent_id", profile.id)
    .eq("type", "upload")
    .eq("asset_role", "source");

  if (cursor) {
    // Strictly after the cursor row in (created_at DESC, id DESC) order. The
    // cursor was validated above, so nothing unexpected reaches the filter.
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);

  if (error) return { ok: false, reason: "read_failed" };

  const rows = (Array.isArray(data) ? data : []) as unknown as RawGalleryRow[];
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  // One batched signing call for exactly this page.
  const paths = pageRows
    .map((r) => (typeof r.file_url === "string" ? r.file_url : ""))
    .filter((p) => p.length > 0);
  const signed = await createPrivateSignedUrls(supabase, paths);

  const media: ParentGalleryMedia[] = [];
  for (const raw of pageRows) {
    const path = typeof raw.file_url === "string" ? raw.file_url : null;
    if (!path) continue;
    // Signed per request and short-lived. The path it was built from never
    // leaves this function; a failed signature degrades only this item.
    const item = toGalleryMedia(raw, signed.get(path) ?? null);
    if (item) media.push(item);
  }

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    if (typeof last.created_at === "string" && typeof last.id === "string") {
      nextCursor = encodeGalleryCursor({ createdAt: last.created_at, id: last.id });
    }
  }

  return { ok: true, media, nextCursor };
}

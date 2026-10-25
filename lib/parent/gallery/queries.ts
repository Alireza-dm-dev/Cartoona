import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createPrivateSignedUrls } from "@/lib/storage/private-signed-url";
import { fetchGalleryPage } from "@/lib/parent/backend-media";
import {
  GALLERY_DEFAULT_PAGE_SIZE,
  clampGalleryPageSize,
  decodeGalleryCursor,
} from "./pagination";
import type { ParentGalleryMedia, ParentGalleryResult } from "./types";

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
 * One page of the signed-in parent's source assets, newest first (V0.1.52).
 *
 * Metadata and ownership come from PostgreSQL through the backend: the keyset
 * query joins `orders` and filters on the profile resolved from the verified
 * assertion, so another parent's row never reaches this process. Storage only
 * signs the object keys of exactly this page, in one batched call. If Storage
 * is down the page still lists every item with `signedUrl: null` (an
 * unavailable tile), and nothing signs the caller out.
 */
export async function getParentGalleryMedia(
  context: VerifiedAuthContext,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ParentGalleryResult> {
  const pageSize = clampGalleryPageSize(options.limit ?? GALLERY_DEFAULT_PAGE_SIZE);

  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
    if (!decodeGalleryCursor(options.cursor)) return { ok: false, reason: "invalid_cursor" };
  }

  const page = await fetchGalleryPage(context, { cursor: options.cursor, limit: pageSize });
  if (!page.ok) {
    if (page.kind === "auth") {
      return { ok: false, reason: page.reason === "no_parent_profile" ? "no_parent_profile" : page.reason === "service_unavailable" ? "read_failed" : "forbidden" };
    }
    if (page.kind === "not_found") return { ok: false, reason: "no_parent_profile" };
    if (page.kind === "invalid") return { ok: false, reason: "invalid_cursor" };
    return { ok: false, reason: "read_failed" };
  }

  // One batched signing call for exactly this page; a failure degrades the tiles.
  let signed = new Map<string, string | null>();
  try {
    const supabase = await createServerSupabaseClient();
    signed = await createPrivateSignedUrls(supabase, page.items.map((i) => i.path));
  } catch {
    signed = new Map();
  }

  const media: ParentGalleryMedia[] = [];
  for (const item of page.items) {
    const m = toGalleryMedia(
      { id: item.id, file_url: item.path, mime_type: item.mimeType, created_at: item.createdAt, original_filename: item.originalFilename },
      signed.get(item.path) ?? null,
    );
    if (m) media.push(m);
  }
  return { ok: true, media, nextCursor: page.nextCursor };
}

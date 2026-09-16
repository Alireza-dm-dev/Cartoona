import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createPrivateSignedUrl } from "@/lib/storage/private-signed-url";
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
 * Every source asset the signed-in parent has uploaded, newest first.
 *
 * Ownership is enforced twice over. The query joins `orders` and filters on
 * the resolved `parent_id`, so another parent's row never reaches this
 * process; row level security applies the same rule independently on the anon
 * key. `asset_role`/`type` restrict the result to parent-uploaded source
 * media, which is what keeps delivered output out of this library.
 */
export async function getParentGalleryMedia(
  supabase: SupabaseClient,
): Promise<ParentGalleryResult> {
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

  const { data, error } = await supabase
    .from("media_assets")
    .select(`${GALLERY_COLUMNS}, orders!inner(parent_id)`)
    .eq("orders.parent_id", profile.id)
    .eq("type", "upload")
    .eq("asset_role", "source")
    .order("created_at", { ascending: false });

  if (error) return { ok: false, reason: "read_failed" };

  const media: ParentGalleryMedia[] = [];
  for (const row of Array.isArray(data) ? data : []) {
    const raw = row as unknown as RawGalleryRow;
    const path = typeof raw.file_url === "string" ? raw.file_url : null;
    if (!path) continue;
    // Signed per render and short-lived. The path it was built from never
    // leaves this function.
    const signedUrl = await createPrivateSignedUrl(supabase, path);
    const item = toGalleryMedia(raw, signedUrl);
    if (item) media.push(item);
  }

  return { ok: true, media };
}

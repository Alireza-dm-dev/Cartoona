import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIVATE_UPLOADS_BUCKET } from "@/lib/storage/private-signed-url";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAssetId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface ResolvedSourceAsset {
  /** Storage path inside the private uploads bucket. Server-side only. */
  path: string;
  mimeType: string | null;
  originalFilename: string | null;
}

export type ResolveSourceAssetResult =
  | { ok: true; asset: ResolvedSourceAsset }
  | { ok: false; reason: "unauthenticated" | "no_parent_profile" | "not_found" | "read_failed" };

/**
 * Resolve a gallery asset the parent selected, proving ownership first.
 *
 * The browser sends a `media_assets.id` and nothing else — never a storage
 * path, which is why the path is looked up here rather than accepted as
 * input. The lookup filters on the resolved `parent_id`, so an id belonging to
 * another parent cannot resolve, and row level security applies the same rule
 * independently.
 *
 * An asset owned by someone else is reported as `not_found`, identical to an
 * id that does not exist, so a crafted id cannot be used to probe whether
 * another parent's media is real.
 */
export async function resolveOwnedSourceAsset(
  supabase: SupabaseClient,
  assetId: unknown,
): Promise<ResolveSourceAssetResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return { ok: false, reason: "unauthenticated" };
  if (!isValidAssetId(assetId)) return { ok: false, reason: "not_found" };

  const { data: profile, error: profileError } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) return { ok: false, reason: "read_failed" };
  if (!profile?.id) return { ok: false, reason: "no_parent_profile" };

  const { data, error } = await supabase
    .from("media_assets")
    .select("file_url, mime_type, original_filename, orders!inner(parent_id)")
    .eq("id", assetId)
    .eq("orders.parent_id", profile.id)
    .eq("type", "upload")
    .eq("asset_role", "source")
    .maybeSingle();

  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "not_found" };

  const path = typeof data.file_url === "string" ? data.file_url : null;
  if (!path) return { ok: false, reason: "not_found" };

  // Defence in depth against a historical row whose path does not follow the
  // per-parent convention: a copy is only ever made from the caller's own
  // folder, whatever the row claims.
  if (!path.startsWith(`${user.id}/`)) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    asset: {
      path,
      mimeType: typeof data.mime_type === "string" ? data.mime_type : null,
      originalFilename:
        typeof data.original_filename === "string" ? data.original_filename : null,
    },
  };
}

/**
 * Derive the file name for the copy that the new order will own.
 *
 * Falls back to the tail of the source path when no original name was
 * recorded. The result is a single path segment: it is joined onto the new
 * order's folder by the caller, so it must not be able to escape it.
 */
export function sourceAssetCopyName(
  asset: ResolvedSourceAsset,
  sanitize: (name: string) => string,
): string {
  const candidate =
    asset.originalFilename?.trim() || asset.path.split("/").pop() || "file";
  return sanitize(candidate);
}

export { PRIVATE_UPLOADS_BUCKET };

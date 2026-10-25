import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { fetchOwnedSourceAsset } from "@/lib/parent/backend-media";
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
 * Resolve a gallery asset the parent selected, proving ownership first
 * (V0.1.52: PostgreSQL through the backend, no Supabase table read).
 *
 * The browser sends a `media_assets.id` and nothing else - never a storage
 * path, which is why the path is looked up here rather than accepted as
 * input. The backend filters on the profile resolved from the verified
 * assertion, so an id belonging to another parent cannot resolve.
 *
 * An asset owned by someone else is reported as `not_found`, identical to an
 * id that does not exist, so a crafted id cannot be used to probe whether
 * another parent's media is real.
 */
export async function resolveOwnedSourceAsset(
  context: VerifiedAuthContext,
  assetId: unknown,
): Promise<ResolveSourceAssetResult> {
  if (!isValidAssetId(assetId)) return { ok: false, reason: "not_found" };

  const found = await fetchOwnedSourceAsset(context, assetId);
  if (!found.ok) {
    if (found.kind === "not_found" || found.kind === "invalid") return { ok: false, reason: "not_found" };
    if (found.kind === "auth") {
      return { ok: false, reason: found.reason === "no_parent_profile" ? "no_parent_profile" : found.reason === "service_unavailable" ? "read_failed" : "not_found" };
    }
    return { ok: false, reason: "read_failed" };
  }

  // Defence in depth against a historical row whose path does not follow the
  // per-parent convention: a copy is only ever made from the caller's own
  // folder, whatever the row claims.
  if (!found.path.startsWith(`${context.identity.subject}/`)) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    asset: { path: found.path, mimeType: found.mimeType, originalFilename: found.originalFilename },
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

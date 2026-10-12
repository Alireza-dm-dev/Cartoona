import type { SupabaseClient } from "@supabase/supabase-js"

export const PRIVATE_UPLOADS_BUCKET = "parent-uploads"

// Short-lived signed URLs for private source media preview/download.
// Must never be persisted. TTL chosen short and consistent with the
// project's short-lived token policy (see lib/auth/dev-parent-auth.ts).
export const PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS = 300

export async function createPrivateSignedUrl(
  supabase: SupabaseClient,
  path: string,
  ttlSeconds: number = PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS,
  bucket: string = PRIVATE_UPLOADS_BUCKET,
  /**
   * When set, the signed URL carries a Content-Disposition that forces a
   * download instead of rendering inline. A string is used as the suggested
   * file name; `true` lets the storage API pick one. Omitted for a plain
   * preview/view URL.
   */
  download?: string | boolean,
): Promise<string | null> {
  if (!path) return null
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, ttlSeconds, download !== undefined ? { download } : undefined)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/**
 * Sign many private objects in ONE storage round trip.
 *
 * Replaces calling `createPrivateSignedUrl` in a loop (one network call per
 * object). Returns a path -> URL map; a path that could not be signed (denied
 * by storage policy, object gone, or the whole batch failed) maps to null so
 * the caller can degrade that single item instead of failing the page.
 * Duplicate paths are signed once.
 */
export async function createPrivateSignedUrls(
  supabase: SupabaseClient,
  paths: string[],
  ttlSeconds: number = PRIVATE_MEDIA_SIGNED_URL_TTL_SECONDS,
  bucket: string = PRIVATE_UPLOADS_BUCKET,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  const unique = [...new Set(paths.filter((p) => typeof p === "string" && p.length > 0))]
  for (const p of unique) result.set(p, null)
  if (unique.length === 0) return result

  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(unique, ttlSeconds)
    if (error || !Array.isArray(data)) return result
    for (const entry of data) {
      if (entry && typeof entry.path === "string" && !entry.error && typeof entry.signedUrl === "string" && entry.signedUrl) {
        result.set(entry.path, entry.signedUrl)
      }
    }
  } catch {
    // Whole batch failed: every item stays null (unavailable preview).
  }
  return result
}

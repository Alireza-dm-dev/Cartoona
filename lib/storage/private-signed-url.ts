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

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
): Promise<string | null> {
  if (!path) return null
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, ttlSeconds)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

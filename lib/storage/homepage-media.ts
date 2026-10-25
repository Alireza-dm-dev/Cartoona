import "server-only"

import { createClient } from "@supabase/supabase-js"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { HOMEPAGE_MEDIA_BUCKET } from "@/lib/admin/homepage/media-validation"

/**
 * Homepage media OBJECT BYTES (V0.1.53). Storage only: no table, no RPC, no role
 * decision. Callers reach the service-credential functions here only AFTER the
 * backend authorized an admin (the write routes call the backend first or
 * immediately after, and refuse a non-admin before any byte is stored).
 */

/** The public URL of an object in the public bucket. Pure string building: no request is made. */
export function homepageMediaPublicUrl(storagePath: string): string {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return ""
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    return client.storage.from(HOMEPAGE_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl
  } catch {
    return ""
  }
}

export async function uploadHomepageMedia(path: string, bytes: Uint8Array, contentType: string): Promise<boolean> {
  try {
    const { error } = await createAdminSupabaseClient().storage.from(HOMEPAGE_MEDIA_BUCKET).upload(path, bytes, { contentType, upsert: false })
    return !error
  } catch {
    return false
  }
}

/** Best-effort removal; never throws. */
export async function removeHomepageMedia(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    await createAdminSupabaseClient().storage.from(HOMEPAGE_MEDIA_BUCKET).remove(paths)
  } catch {
    // best-effort only
  }
}

import "server-only"

import { createClient } from "@supabase/supabase-js"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { EXAMPLE_MEDIA_BUCKET } from "@/lib/examples/example-storage"

/**
 * Examples CMS image BYTES (V0.1.53). Storage only. These used to run with the
 * admin's session client and the bucket's Storage policy, which reads the
 * Supabase `users` table; PostgreSQL now authorizes the admin (backend) and the
 * service credential does the byte work, so no Supabase table decides anything.
 */

export function exampleMediaPublicUrl(storagePath: string): string {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return ""
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    return client.storage.from(EXAMPLE_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl
  } catch {
    return ""
  }
}

export async function uploadExampleImage(path: string, file: File): Promise<boolean> {
  try {
    const { error } = await createAdminSupabaseClient().storage.from(EXAMPLE_MEDIA_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
    return !error
  } catch {
    return false
  }
}

export async function removeExampleImage(path: string): Promise<void> {
  try {
    await createAdminSupabaseClient().storage.from(EXAMPLE_MEDIA_BUCKET).remove([path])
  } catch {
    // best-effort only
  }
}

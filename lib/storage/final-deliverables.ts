import "server-only"

import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { log } from "@/lib/observability/request-context"
import { categorizeError } from "@/lib/observability/errors"
import { FINAL_DELIVERABLES_BUCKET } from "@/lib/admin/requests/media-validation"

/**
 * Storage for FINAL DELIVERABLE bytes (V0.1.52): upload, remove and sign, using
 * the server-only service credential. Authorization is NOT decided here and not
 * by Supabase Storage policies (they read the Supabase `media_assets` table,
 * which no longer holds PostgreSQL-created orders): callers sign a key ONLY
 * after PostgreSQL ownership/visibility selected the row (parent) or after the
 * backend recorded the key for an admin. No function accepts a key from a
 * browser. Failures degrade to `null` / `false`; nothing here throws, and the
 * log carries the bucket and an error category, never a key or URL.
 */

function client() {
  try {
    return createAdminSupabaseClient()
  } catch {
    return null
  }
}

export async function signFinalDeliverable(path: string, ttlSeconds: number, download?: string | boolean): Promise<string | null> {
  const admin = client()
  if (!admin || !path) return null
  try {
    const { data, error } = await admin.storage
      .from(FINAL_DELIVERABLES_BUCKET)
      .createSignedUrl(path, ttlSeconds, download !== undefined ? { download } : undefined)
    if (error || !data?.signedUrl) {
      log("warn", "STORAGE_SIGNED_URL_FAILED", { subsystem: "storage", operation: "sign_url", bucket: FINAL_DELIVERABLES_BUCKET, errorCode: categorizeError(error, "storage") })
      return null
    }
    return data.signedUrl
  } catch (error) {
    log("warn", "STORAGE_SIGNED_URL_FAILED", { subsystem: "storage", operation: "sign_url", bucket: FINAL_DELIVERABLES_BUCKET, errorCode: categorizeError(error, "storage") })
    return null
  }
}

export async function uploadFinalDeliverable(path: string, bytes: ArrayBuffer, contentType: string): Promise<boolean> {
  const admin = client()
  if (!admin) return false
  try {
    const { error } = await admin.storage.from(FINAL_DELIVERABLES_BUCKET).upload(path, bytes, { contentType, upsert: false })
    return !error
  } catch {
    return false
  }
}

/** Best-effort rollback of an uploaded object. Never throws. */
export async function removeFinalDeliverable(path: string): Promise<void> {
  const admin = client()
  if (!admin) return
  try {
    await admin.storage.from(FINAL_DELIVERABLES_BUCKET).remove([path])
  } catch {
    // best-effort only
  }
}

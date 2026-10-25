import "server-only"

import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { PRIVATE_UPLOADS_BUCKET, createPrivateSignedUrls } from "@/lib/storage/private-signed-url"

/**
 * Storage for PARENT SOURCE UPLOADS (V0.1.54): write, copy and remove, with the
 * server-only service credential.
 *
 * Until V0.1.53 POST /api/requests wrote these objects with the PARENT'S OWN
 * session under the `parent_uploads_*` Storage policies, which decide access by
 * calling the Supabase-database functions `public.is_parent()` / `is_admin()`.
 * After the database cutover a parent created in PostgreSQL has no row there, so
 * every upload would be refused, and a role changed in PostgreSQL would never
 * reach the policy. Storage policies therefore decide NOTHING any more: access
 * is decided by PostgreSQL (the verified parent, role and consent are checked by
 * the backend before this module is reached), and this module only enforces the
 * namespace:
 *
 *   - every key is `<verified subject>/<order id>/<file name>`, built by the
 *     route from the verified session, never from browser input;
 *   - a copy may only read from the SAME subject's folder (the source key was
 *     already proven to belong to this parent in PostgreSQL; this re-checks it);
 *   - no `..`, no leading slash, no empty segment.
 *
 * Functions return the storage error (or null) so the route keeps its existing
 * categorised logging; nothing here logs a key.
 */

type StorageError = { message?: string } | null

const SEGMENT = /^[^/\\\0]{1,200}$/

/** `<subject>/<orderId>/<name>` under the given subject, no traversal. */
export function isOwnedUploadKey(key: string, subject: string): boolean {
  if (!subject || subject.includes("/")) return false
  const parts = key.split("/")
  return parts.length === 3 && parts[0] === subject && parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")
}

const refused = (): { message: string } => ({ message: "storage key refused" })

export async function uploadParentSource(subject: string, key: string, file: Blob, contentType: string): Promise<StorageError> {
  if (!isOwnedUploadKey(key, subject)) return refused()
  try {
    const { error } = await createAdminSupabaseClient().storage.from(PRIVATE_UPLOADS_BUCKET).upload(key, file, { contentType, upsert: false })
    return error
  } catch (error) {
    return { message: error instanceof Error ? error.message : "storage unavailable" }
  }
}

export async function copyParentSource(subject: string, fromKey: string, toKey: string): Promise<StorageError> {
  if (!isOwnedUploadKey(fromKey, subject) || !isOwnedUploadKey(toKey, subject)) return refused()
  try {
    const { error } = await createAdminSupabaseClient().storage.from(PRIVATE_UPLOADS_BUCKET).copy(fromKey, toKey)
    return error
  } catch (error) {
    return { message: error instanceof Error ? error.message : "storage unavailable" }
  }
}

/** Best-effort rollback of an object this request wrote. */
export async function removeParentSource(subject: string, key: string): Promise<StorageError> {
  if (!isOwnedUploadKey(key, subject)) return refused()
  try {
    const { error } = await createAdminSupabaseClient().storage.from(PRIVATE_UPLOADS_BUCKET).remove([key])
    return error
  } catch (error) {
    return { message: error instanceof Error ? error.message : "storage unavailable" }
  }
}

/**
 * Short-lived signed preview URLs (one batch) for source keys that PostgreSQL
 * already selected for THIS viewer: the parent's own gallery/order rows, or an
 * admin's request detail (the backend gated the role). Never call it with a key
 * from a browser. A failure degrades to null URLs, never throws.
 */
export async function signParentSources(paths: string[]): Promise<Map<string, string | null>> {
  try {
    return await createPrivateSignedUrls(createAdminSupabaseClient(), paths)
  } catch {
    return new Map(paths.map((p) => [p, null]))
  }
}

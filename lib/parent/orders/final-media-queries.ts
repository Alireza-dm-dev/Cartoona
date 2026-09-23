import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * The parent-facing final-deliverable boundary.
 *
 * This module exists so the on-demand signed-URL route
 * (app/api/parent/orders/[orderId]/final-media) and the order detail page's
 * SSR read (detail-queries.ts) resolve "which final asset may this parent
 * see" through exactly one query shape, rather than two hand-copied ones that
 * could drift.
 *
 * The predicate mirrors `public.is_parent_approved_final_deliverable`, the
 * function the `final-deliverables` storage RLS policy already trusts:
 * asset_role = 'final', delivery_status = 'approved', parent_visible = true.
 * Explicit here even though the `media_assets_select_own_parent` RLS policy
 * already enforces the same rule for any query run on the parent's own
 * session client — defense in depth, matching the rest of this codebase,
 * never a substitute for it. Ownership must always be checked with the same
 * session client so RLS is the second, independent guard.
 */

export type ResolveParentOrderResult =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "not_parent" | "no_parent_profile" | "not_found" }

/**
 * Whether `orderId` belongs to the signed-in parent.
 *
 * An order belonging to someone else and an order id that does not exist
 * resolve to the identical `not_found` reason, so this can never be used to
 * probe whether another parent's order is real.
 */
export async function resolveParentOwnsOrder(
  supabase: SupabaseClient,
  orderId: string,
): Promise<ResolveParentOrderResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, reason: "unauthenticated" }

  const { data: userRow } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow || userRow.role !== "parent") return { ok: false, reason: "not_parent" }

  const { data: profile } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (!profile?.id) return { ok: false, reason: "no_parent_profile" }

  const { data: order } = await supabase
    .from("orders")
    .select("id")
    .eq("id", orderId)
    .eq("parent_id", profile.id)
    .maybeSingle()
  if (!order) return { ok: false, reason: "not_found" }

  return { ok: true }
}

export interface ParentFinalMediaRow {
  id: string
  /** Storage path. Never leaves this module — callers sign it or drop it. */
  path: string
  mimeType: string | null
  fileName: string | null
}

/**
 * The current eligible final deliverable for an order, or null.
 *
 * "Current eligible" means exactly one thing: an approved, parent-visible
 * final asset. A superseded or merely-uploaded-but-unapproved asset is never
 * returned, so a caller cannot accidentally mint a signed URL for either —
 * there is no path through this function that reaches one.
 *
 * Ordered so that if more than one row could ever satisfy the predicate
 * (it shouldn't — supersede clears parent_visible before a replacement is
 * approved), the most recently created wins rather than an arbitrary one.
 */
export async function resolveCurrentParentFinalMedia(
  supabase: SupabaseClient,
  orderId: string,
): Promise<ParentFinalMediaRow | null> {
  const { data } = await supabase
    .from("media_assets")
    .select("id, file_url, mime_type, original_filename")
    .eq("order_id", orderId)
    .eq("asset_role", "final")
    .eq("delivery_status", "approved")
    .eq("parent_visible", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  const path = typeof data.file_url === "string" ? data.file_url : null
  if (!path) return null

  const originalFilename =
    typeof data.original_filename === "string" && data.original_filename.trim().length > 0
      ? data.original_filename.trim()
      : null

  return {
    id: String(data.id),
    path,
    mimeType: typeof data.mime_type === "string" ? data.mime_type : null,
    fileName: originalFilename,
  }
}

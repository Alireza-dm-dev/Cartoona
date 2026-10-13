import "server-only"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { log } from "@/lib/observability/request-context"
import { categorizeError } from "@/lib/observability/errors"

/**
 * Audit trail for final-media signed-URL mints.
 *
 * `public.audit_logs` (actor_id, action, target_type, target_id, metadata,
 * created_at) already exists in the base schema and has never been written
 * to by any feature until now. It carries no RLS policy — inspected before
 * adding this, per the task's instruction to report rather than invent a new
 * table — so it is written here only through the service-role admin client,
 * never exposed to `anon`/`authenticated`. That is the same trust boundary
 * every other trusted mutation in this codebase already relies on.
 *
 * Best-effort but NOT silent: a failed audit write never fails the signed-URL
 * response it is recording, but it is always logged (AUDIT_WRITE_FAILED) so a
 * missing audit row is detectable. Callers should AWAIT this - a detached
 * promise can be dropped when a serverless instance freezes after the response.
 */

export type FinalMediaAuditAction = "final_media_view" | "final_media_download"

export async function recordFinalMediaAudit(input: {
  actorUserId: string
  orderId: string
  mediaAssetId: string
  action: FinalMediaAuditAction
}): Promise<void> {
  try {
    const admin = createAdminSupabaseClient()
    // Never audit the signed URL, its token, or any other secret — only the
    // identifiers needed to answer "who accessed what, and when".
    const { error } = await admin.from("audit_logs").insert({
      actor_id: input.actorUserId,
      action: input.action,
      target_type: "media_asset",
      target_id: input.mediaAssetId,
      metadata: { orderId: input.orderId },
    })
    // supabase-js reports most failures as a returned `error`, not a throw.
    if (error) logAuditFailure(input, error)
  } catch (error) {
    logAuditFailure(input, error)
  }
}

function logAuditFailure(
  input: { orderId: string; mediaAssetId: string; action: FinalMediaAuditAction },
  error: unknown,
): void {
  log("error", "AUDIT_WRITE_FAILED", {
    subsystem: "audit",
    operation: input.action,
    orderId: input.orderId,
    mediaAssetId: input.mediaAssetId,
    errorCode: categorizeError(error, "database"),
  })
}

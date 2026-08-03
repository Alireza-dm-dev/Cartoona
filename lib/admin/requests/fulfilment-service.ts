import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAdminRole } from "@/lib/auth/admin-role";
import type { FulfilmentApiErrorCode } from "@/lib/admin/requests/fulfilment-error-codes";
import type {
  AdminFinalMediaInfo,
  AdminHistoryItem,
  AdminStatusUpdateInput,
  AdminStatusUpdateResult,
} from "@/lib/admin/requests/fulfilment-types";
import { toAdminFinalMediaInfo, toAdminHistoryItem } from "@/lib/admin/requests/fulfilment-types";
import { mapFulfilmentRpcError } from "@/lib/admin/requests/fulfilment-errors";
import { FINAL_DELIVERABLES_BUCKET } from "@/lib/admin/requests/media-validation";
import { createPrivateSignedUrl } from "@/lib/storage/private-signed-url";

export const FULFILMENT_JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function fulfilmentJsonError(
  message: string,
  status: number,
  code?: FulfilmentApiErrorCode,
): NextResponse {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status, headers: FULFILMENT_JSON_HEADERS },
  );
}

/** Structured RPC/storage failure — lets callers build the exact error shape. */
export interface FulfilmentRpcFailure {
  ok: false;
  code: FulfilmentApiErrorCode;
  message: string;
  status: number;
}

function rpcFailure(message: unknown): FulfilmentRpcFailure {
  const mapped = mapFulfilmentRpcError(message);
  return { ok: false, code: mapped.code, message: mapped.message, status: mapped.status };
}

/**
 * Authenticates the request as an admin / super_admin and returns the verified
 * server supabase client plus the user id. On failure returns a NextResponse.
 * Admin routes do NOT run the parent session-lifetime check.
 */
export async function requireAdminFulfilmentAuth(): Promise<
  | { ok: true; supabase: SupabaseClient; adminUserId: string }
  | { ok: false; response: NextResponse }
> {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return { ok: false, response: fulfilmentJsonError("خطای احراز هویت رخ داد.", 500) };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: fulfilmentJsonError("لطفاً ابتدا وارد حساب خود شوید.", 401) };
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (roleError || !roleRow || !isAdminRole(roleRow.role)) {
    return { ok: false, response: fulfilmentJsonError("شما مجوز انجام این عملیات را ندارید.", 403) };
  }

  return { ok: true, supabase, adminUserId: user.id };
}

/* ── Trusted RPC mutations (service_role only) ──────────────────────────────── */

export async function updateOrderStatusViaTrustedRpc(
  adminUserId: string,
  requestId: string,
  input: AdminStatusUpdateInput,
): Promise<{ ok: true; result: AdminStatusUpdateResult } | FulfilmentRpcFailure> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "ذخیره تغییر وضعیت انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("update_order_status_trusted", {
    p_admin_user_id: adminUserId,
    p_order_id: requestId,
    p_new_status: input.status,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_internal_note: input.internalNote,
    p_parent_visible_note: input.parentVisibleNote,
  });

  if (error) return rpcFailure(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.order_id !== "string" ||
    typeof row.status !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.history_id !== "string"
  ) {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "ذخیره تغییر وضعیت انجام نشد.", status: 500 };
  }

  return {
    ok: true,
    result: {
      orderId: row.order_id,
      previousStatus: (typeof row.previous_status === "string" ? row.previous_status : null) as AdminStatusUpdateResult["previousStatus"],
      status: row.status as AdminStatusUpdateResult["status"],
      updatedAt: row.updated_at,
      historyId: row.history_id,
    },
  };
}

export async function recordFinalMediaViaTrustedRpc(
  adminUserId: string,
  orderId: string,
  params: { filePath: string; mimeType: string; byteSize: number; originalFilename: string },
): Promise<{ ok: true; assetId: string } | FulfilmentRpcFailure> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "ثبت فایل انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("record_final_media_trusted", {
    p_admin_user_id: adminUserId,
    p_order_id: orderId,
    p_file_path: params.filePath,
    p_mime_type: params.mimeType,
    p_byte_size: params.byteSize,
    p_original_filename: params.originalFilename,
  });

  if (error) return rpcFailure(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const assetId = row?.asset_id;
  if (typeof assetId !== "string") {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "ثبت فایل انجام نشد.", status: 500 };
  }
  return { ok: true, assetId };
}

export async function approveFinalMediaViaTrustedRpc(
  adminUserId: string,
  orderId: string,
  assetId: string,
): Promise<{ ok: true; assetId: string } | FulfilmentRpcFailure> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "تأیید فایل انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("approve_final_media_trusted", {
    p_admin_user_id: adminUserId,
    p_order_id: orderId,
    p_asset_id: assetId,
  });

  if (error) return rpcFailure(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (typeof row?.asset_id !== "string") {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "تأیید فایل انجام نشد.", status: 500 };
  }
  return { ok: true, assetId: row.asset_id };
}

export async function supersedeFinalMediaViaTrustedRpc(
  adminUserId: string,
  orderId: string,
  assetId: string,
): Promise<{ ok: true; assetId: string } | FulfilmentRpcFailure> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "جایگزینی فایل انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("supersede_final_media_trusted", {
    p_admin_user_id: adminUserId,
    p_order_id: orderId,
    p_asset_id: assetId,
  });

  if (error) return rpcFailure(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (typeof row?.asset_id !== "string") {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "جایگزینی فایل انجام نشد.", status: 500 };
  }
  return { ok: true, assetId: row.asset_id };
}

/* ── Storage (service_role admin client) ────────────────────────────────────── */

export type StorageUploadResult =
  | { ok: true; path: string }
  | { ok: false; code: FulfilmentApiErrorCode; message: string; status: number };

export async function uploadFinalDeliverableToStorage(
  orderId: string,
  storagePath: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<StorageUploadResult> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "بارگذاری فایل انجام نشد.", status: 500 };
  }

  const { error } = await admin.storage
    .from(FINAL_DELIVERABLES_BUCKET)
    .upload(storagePath, bytes, { contentType, upsert: false });

  if (error) {
    return { ok: false, code: "REQUEST_UNKNOWN_ERROR", message: "بارگذاری فایل انجام نشد.", status: 500 };
  }
  return { ok: true, path: storagePath };
}

/**
 * Best-effort rollback of an uploaded storage object after a failed DB insert.
 * Never throws — failure here is logged by the caller and does not mask the
 * original error.
 */
export async function deleteFinalDeliverableFromStorage(storagePath: string): Promise<void> {
  try {
    const admin = createAdminSupabaseClient();
    await admin.storage.from(FINAL_DELIVERABLES_BUCKET).remove([storagePath]);
  } catch {
    // best-effort only
  }
}

/* ── Reads (authenticated admin client; mirrors queryAdminRequestDetail) ────── */

export async function loadAdminFinalMedia(
  supabase: SupabaseClient,
  orderId: string,
): Promise<AdminFinalMediaInfo[]> {
  const { data, error } = await supabase
    .from("media_assets")
    .select("id, file_url, mime_type, byte_size, created_at, superseded_at, delivery_status, parent_visible")
    .eq("order_id", orderId)
    .eq("asset_role", "final")
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  const result: AdminFinalMediaInfo[] = [];
  for (const asset of data) {
    // Signed URLs only for live assets (uploaded/approved). Superseded assets
    // keep a null URL — they are retained for audit but not downloadable.
    const live = asset.delivery_status === "uploaded" || asset.delivery_status === "approved";
    const signedUrl = live ? await createPrivateSignedUrl(supabase, asset.file_url, 300, FINAL_DELIVERABLES_BUCKET) : null;
    result.push(
      toAdminFinalMediaInfo(
        {
          id: asset.id,
          file_url: asset.file_url,
          mime_type: asset.mime_type,
          byte_size: asset.byte_size,
          created_at: asset.created_at,
          superseded_at: asset.superseded_at,
          delivery_status: asset.delivery_status,
          parent_visible: asset.parent_visible === true,
        },
        signedUrl,
      ),
    );
  }
  return result;
}

export async function loadAdminFulfilmentHistory(
  supabase: SupabaseClient,
  orderId: string,
): Promise<AdminHistoryItem[] | null> {
  const { data, error } = await supabase.rpc("get_order_status_history_admin", {
    p_order_id: orderId,
  });

  if (error) return null;
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) =>
    toAdminHistoryItem({
      id: String(r.id ?? ""),
      previous_status: r.previous_status ?? null,
      new_status: String(r.new_status ?? "pending_review"),
      changed_by: r.changed_by_name ?? null,
      changed_by_deleted: Boolean(r.changed_by_deleted),
      internal_note: r.internal_note ?? null,
      parent_visible_note: r.parent_visible_note ?? null,
      created_at: String(r.created_at ?? ""),
    }),
  );
}

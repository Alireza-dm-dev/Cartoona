import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Admin request (order) views and fulfilment on plain PostgreSQL (V0.1.52).
 * Reads are SELECTs; every write is an existing trusted function (0005, granted
 * by 0018) that re-checks the admin role in the database, locks the order,
 * enforces the transition map and appends history in the same statement. The
 * acting admin is always the caller's resolved user id, never a body value.
 */

export interface AdminQueueRowData {
  id: string;
  type: string;
  status: string;
  title: string | null;
  candy_cost: number;
  created_at: string;
  updated_at: string;
  parent_full_name: string | null;
  parent_missing: boolean;
}

const COUNT_QUEUE = `SELECT count(*)::int AS n FROM public.orders o WHERE ($1::text IS NULL OR o.type = $1) AND ($2::text IS NULL OR o.status = $2)`;

const SELECT_QUEUE_PAGE = `
  SELECT o.id, o.type, o.status, o.title, o.candy_cost,
         to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at,
         p.full_name AS parent_full_name, (p.id IS NULL) AS parent_missing
  FROM public.orders o
  LEFT JOIN public.parent_profiles p ON p.id = o.parent_id
  WHERE ($1::text IS NULL OR o.type = $1) AND ($2::text IS NULL OR o.status = $2)
  ORDER BY o.created_at DESC, o.id DESC
  LIMIT $3 OFFSET $4`;

export async function listAdminQueue(
  db: Queryable,
  input: { type: string | null; status: string | null; page: number; pageSize: number },
): Promise<{ rows: AdminQueueRowData[]; total: number }> {
  const total = (await runQuery<{ n: number }>(db, COUNT_QUEUE, [input.type, input.status]))[0].n;
  const rows = await runQuery<AdminQueueRowData>(db, SELECT_QUEUE_PAGE, [
    input.type,
    input.status,
    input.pageSize,
    (input.page - 1) * input.pageSize,
  ]);
  return { rows, total };
}

export interface AdminOrderRow {
  id: string;
  type: string;
  status: string;
  title: string | null;
  description: string | null;
  child_name: string | null;
  candy_cost: number;
  moderation_status: string;
  created_at: string;
  updated_at: string;
  character_name: string | null;
  parent_full_name: string | null;
  parent_email: string | null;
  parent_missing: boolean;
  video_script: string | null;
  video_style: string | null;
  video_duration_seconds: number | null;
  video_duration_choice: string | null;
  video_characters_speak: boolean | null;
  drawing_upload_url: string | null;
  drawing_animation_style: string | null;
}

/** `updated_at` is the optimistic-concurrency token: microsecond text, round-tripped untouched. */
const SELECT_ADMIN_ORDER = `
  SELECT o.id, o.type, o.status, o.title, o.description, o.child_name, o.candy_cost, o.moderation_status,
         to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at,
         c.name AS character_name, p.full_name AS parent_full_name, u.email AS parent_email, (p.id IS NULL) AS parent_missing,
         v.script AS video_script, v.style AS video_style, v.duration_seconds AS video_duration_seconds,
         v.duration_choice AS video_duration_choice, v.characters_speak AS video_characters_speak,
         d.upload_url AS drawing_upload_url, d.animation_style AS drawing_animation_style
  FROM public.orders o
  LEFT JOIN public.characters c ON c.id = o.character_id
  LEFT JOIN public.parent_profiles p ON p.id = o.parent_id
  LEFT JOIN public.users u ON u.id = p.user_id
  LEFT JOIN public.video_requests v ON v.order_id = o.id
  LEFT JOIN public.drawing_animation_requests d ON d.order_id = o.id
  WHERE o.id = $1`;

export interface AdminMediaRow {
  id: string;
  type: string;
  asset_role: string;
  path: string;
  mime_type: string | null;
  byte_size: number | null;
  created_at: string;
  superseded_at: string | null;
  delivery_status: string | null;
  parent_visible: boolean;
}

const SELECT_ADMIN_MEDIA = `
  SELECT m.id, m.type, m.asset_role, m.file_url AS path, m.mime_type, m.byte_size,
         to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         CASE WHEN m.superseded_at IS NULL THEN NULL ELSE to_char(m.superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') END AS superseded_at,
         m.delivery_status, m.parent_visible
  FROM public.media_assets m
  WHERE m.order_id = $1
  ORDER BY m.created_at DESC, m.id DESC`;

export interface AdminHistoryRow {
  id: string;
  previous_status: string | null;
  new_status: string;
  changed_by_name: string | null;
  changed_by_deleted: boolean;
  internal_note: string | null;
  parent_visible_note: string | null;
  created_at: string;
}

const SELECT_ADMIN_HISTORY = `
  SELECT id, previous_status, new_status, changed_by_name, changed_by_deleted, internal_note, parent_visible_note,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at
  FROM public.get_order_status_history_admin_trusted($1, $2)`;

export interface AdminOrderData {
  order: AdminOrderRow;
  media: AdminMediaRow[];
  history: AdminHistoryRow[];
}

/** One order for the admin detail page; the history function re-checks the admin role in the database. */
export async function getAdminOrderData(db: Queryable, input: { adminUserId: string; orderId: string }): Promise<AdminOrderData | null> {
  const adminUserId = requireUuid(input.adminUserId, "adminUserId");
  const orderId = requireUuid(input.orderId, "orderId");
  const rows = await runQuery<AdminOrderRow>(db, SELECT_ADMIN_ORDER, [orderId]);
  if (!rows[0]) return null;
  const [media, history] = await Promise.all([
    runQuery<AdminMediaRow>(db, SELECT_ADMIN_MEDIA, [orderId]),
    runQuery<AdminHistoryRow>(db, SELECT_ADMIN_HISTORY, [adminUserId, orderId]),
  ]);
  return { order: rows[0], media, history };
}

export interface StatusUpdateResult {
  order_id: string;
  previous_status: string;
  new_status: string;
  updated_at: string;
  history_id: string;
}

export async function updateOrderStatus(
  db: Queryable,
  input: { adminUserId: string; orderId: string; status: string; expectedUpdatedAt: string; internalNote: string | null; parentVisibleNote: string | null },
): Promise<StatusUpdateResult> {
  const rows = await runQuery<StatusUpdateResult>(
    db,
    `SELECT order_id, previous_status, new_status,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at, history_id
     FROM public.update_order_status_trusted($1, $2, $3, $4::timestamptz, $5, $6)`,
    [requireUuid(input.orderId, "orderId"), requireUuid(input.adminUserId, "adminUserId"), input.status, input.expectedUpdatedAt, input.internalNote, input.parentVisibleNote],
  );
  if (!rows[0]) throw new TypeError("update_order_status_trusted returned no row");
  return rows[0];
}

/** Current status + token of an order, to resolve a retry whose first try already committed. */
export async function getOrderState(db: Queryable, orderId: string): Promise<{ status: string; updated_at: string; history_id: string } | null> {
  const rows = await runQuery<{ status: string; updated_at: string; history_id: string }>(
    db,
    `SELECT o.status, to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS updated_at,
            (SELECT h.id FROM public.order_status_history h WHERE h.order_id = o.id ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS history_id
     FROM public.orders o WHERE o.id = $1`,
    [requireUuid(orderId, "orderId")],
  );
  return rows[0] ?? null;
}

export async function recordFinalMedia(
  db: Queryable,
  input: { adminUserId: string; orderId: string; filePath: string; mimeType: string; byteSize: number; originalFilename: string },
): Promise<string> {
  const rows = await runQuery<{ asset_id: string }>(
    db,
    `SELECT asset_id FROM public.record_final_media_trusted($1, $2, $3, $4, $5, $6)`,
    [requireUuid(input.adminUserId, "adminUserId"), requireUuid(input.orderId, "orderId"), input.filePath, input.mimeType, input.byteSize, input.originalFilename],
  );
  return rows[0].asset_id;
}

export async function approveFinalMedia(db: Queryable, input: { adminUserId: string; orderId: string; assetId: string }): Promise<string> {
  const rows = await runQuery<{ asset_id: string }>(db, `SELECT asset_id FROM public.approve_final_media_trusted($1, $2, $3)`, [
    requireUuid(input.adminUserId, "adminUserId"),
    requireUuid(input.assetId, "assetId"),
    requireUuid(input.orderId, "orderId"),
  ]);
  return rows[0].asset_id;
}

export async function supersedeFinalMedia(db: Queryable, input: { adminUserId: string; orderId: string; assetId: string }): Promise<string> {
  const rows = await runQuery<{ asset_id: string }>(db, `SELECT asset_id FROM public.supersede_final_media_trusted($1, $2, $3)`, [
    requireUuid(input.adminUserId, "adminUserId"),
    requireUuid(input.assetId, "assetId"),
    requireUuid(input.orderId, "orderId"),
  ]);
  return rows[0].asset_id;
}

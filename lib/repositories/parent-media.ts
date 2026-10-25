import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

/**
 * Parent order detail, gallery and final-media METADATA on plain PostgreSQL
 * (V0.1.52). Object bytes are not here: every row carries an object KEY that
 * only server code ever signs, and only after the ownership/visibility
 * predicates below have selected the row. Nothing here accepts a user or
 * parent id from a request: callers pass the profile they resolved from the
 * verified assertion; ownership is `o.parent_id = $profile` in the SQL.
 *
 * Keys (`path`) are returned to the BACKEND ROUTES only; the route replies to
 * the Next BFF server-to-server, and the BFF turns them into short-lived signed
 * URLs. They never reach a browser.
 */

export interface ParentOrderRow {
  id: string;
  type: string;
  status: string;
  title: string | null;
  description: string | null;
  child_name: string | null;
  candy_cost: number;
  created_at: string;
  character_name: string | null;
  video_script: string | null;
  video_style: string | null;
  video_duration_seconds: number | null;
  video_duration_choice: string | null;
  video_characters_speak: boolean | null;
  drawing_animation_style: string | null;
}

const SELECT_ORDER = `
  SELECT o.id, o.type, o.status, o.title, o.description, o.child_name, o.candy_cost,
         to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         c.name AS character_name,
         v.script AS video_script, v.style AS video_style, v.duration_seconds AS video_duration_seconds,
         v.duration_choice AS video_duration_choice, v.characters_speak AS video_characters_speak,
         d.animation_style AS drawing_animation_style
  FROM public.orders o
  LEFT JOIN public.characters c ON c.id = o.character_id
  LEFT JOIN public.video_requests v ON v.order_id = o.id
  LEFT JOIN public.drawing_animation_requests d ON d.order_id = o.id
  WHERE o.id = $1 AND o.parent_id = $2`;

export interface SourceMediaRow {
  id: string;
  mime_type: string | null;
  created_at: string;
  path: string;
}

const SELECT_SOURCE_MEDIA = `
  SELECT m.id, m.mime_type, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         m.file_url AS path
  FROM public.media_assets m
  WHERE m.order_id = $1 AND m.type = 'upload' AND m.file_url <> ''
  ORDER BY m.created_at ASC, m.id ASC`;

export interface ParentHistoryRow {
  previous_status: string | null;
  new_status: string;
  parent_visible_note: string | null;
  created_at: string;
}

/** The same four columns get_parent_order_status_history_trusted returns: never an internal note or an actor. */
const SELECT_PARENT_HISTORY = `
  SELECT h.previous_status, h.new_status, h.parent_visible_note,
         to_char(h.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at
  FROM public.order_status_history h
  WHERE h.order_id = $1
  ORDER BY h.created_at DESC, h.id DESC`;

export interface FinalMediaMeta {
  id: string;
  path: string;
  mime_type: string | null;
  file_name: string | null;
}

/**
 * The current eligible final deliverable of an order the PROFILE owns, or null:
 * asset_role = final, delivery_status = approved, parent_visible = true (the
 * predicate the Supabase storage policy used, now evaluated here). Ownership is
 * part of the statement, so a foreign order id selects nothing.
 */
const SELECT_CURRENT_FINAL = `
  SELECT m.id, m.file_url AS path, m.mime_type, nullif(btrim(m.original_filename), '') AS file_name
  FROM public.media_assets m
  JOIN public.orders o ON o.id = m.order_id
  WHERE m.order_id = $1 AND o.parent_id = $2
    AND m.asset_role = 'final' AND m.delivery_status = 'approved' AND m.parent_visible = true
    AND m.file_url <> ''
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1`;

export interface ParentOrderDetailData {
  order: ParentOrderRow;
  sourceMedia: SourceMediaRow[];
  history: ParentHistoryRow[];
  finalMedia: { id: string; mimeType: string | null; fileName: string | null } | null;
}

/**
 * One parent's own order with everything the detail page shows. Ownership is
 * resolved FIRST and alone; the three dependent reads (source media, parent-safe
 * history, current final) run concurrently and only for a proven order. Null =
 * not found OR not the caller's (indistinguishable by design).
 */
export async function getParentOrderDetailData(
  db: Queryable,
  input: { parentProfileId: string; orderId: string },
): Promise<ParentOrderDetailData | null> {
  const parentProfileId = requireUuid(input.parentProfileId, "parentProfileId");
  const orderId = requireUuid(input.orderId, "orderId");
  const rows = await runQuery<ParentOrderRow>(db, SELECT_ORDER, [orderId, parentProfileId]);
  const order = rows[0];
  if (!order) return null;
  const [sourceMedia, history, final] = await Promise.all([
    runQuery<SourceMediaRow>(db, SELECT_SOURCE_MEDIA, [orderId]),
    runQuery<ParentHistoryRow>(db, SELECT_PARENT_HISTORY, [orderId]),
    runQuery<FinalMediaMeta>(db, SELECT_CURRENT_FINAL, [orderId, parentProfileId]),
  ]);
  const f = final[0];
  return { order, sourceMedia, history, finalMedia: f ? { id: f.id, mimeType: f.mime_type, fileName: f.file_name } : null };
}

/** The final deliverable (with its object key) for signing, or null. Ownership and visibility are in the SQL. */
export async function findCurrentFinalMedia(
  db: Queryable,
  input: { parentProfileId: string; orderId: string },
): Promise<FinalMediaMeta | null> {
  const rows = await runQuery<FinalMediaMeta>(db, SELECT_CURRENT_FINAL, [
    requireUuid(input.orderId, "orderId"),
    requireUuid(input.parentProfileId, "parentProfileId"),
  ]);
  return rows[0] ?? null;
}

const SELECT_ORDER_OWNED = `SELECT true AS ok FROM public.orders o WHERE o.id = $1 AND o.parent_id = $2`;

export async function parentOwnsOrder(db: Queryable, input: { parentProfileId: string; orderId: string }): Promise<boolean> {
  const rows = await runQuery<{ ok: boolean }>(db, SELECT_ORDER_OWNED, [
    requireUuid(input.orderId, "orderId"),
    requireUuid(input.parentProfileId, "parentProfileId"),
  ]);
  return rows.length === 1;
}

export async function recordFinalMediaAccess(
  db: Queryable,
  input: { actorUserId: string; orderId: string; assetId: string; action: "final_media_view" | "final_media_download" },
): Promise<void> {
  await runQuery(db, `SELECT public.record_final_media_access_audit_trusted($1, $2, $3, $4)`, [
    requireUuid(input.actorUserId, "actorUserId"),
    requireUuid(input.orderId, "orderId"),
    requireUuid(input.assetId, "assetId"),
    input.action,
  ]);
}

// ── gallery ──────────────────────────────────────────────────────────────────

export interface GalleryRow {
  id: string;
  mime_type: string | null;
  created_at: string;
  original_filename: string | null;
  path: string;
}

/**
 * A page of the parent's own SOURCE uploads, newest first, keyset on
 * (created_at DESC, id DESC): $3/$4 are the cursor (null on page 1), $5 the page
 * size + 1. The cursor timestamp is the exact microsecond text the previous page
 * returned, bound as a timestamptz parameter, never spliced into SQL.
 */
const SELECT_GALLERY_PAGE = `
  SELECT m.id, m.mime_type, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
         m.original_filename, m.file_url AS path
  FROM public.media_assets m
  JOIN public.orders o ON o.id = m.order_id
  WHERE o.parent_id = $1 AND m.type = 'upload' AND m.asset_role = 'source' AND m.file_url <> ''
    AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT $4`;

export async function listGalleryPage(
  db: Queryable,
  input: { parentProfileId: string; cursor: { createdAt: string; id: string } | null; limitPlusOne: number },
): Promise<GalleryRow[]> {
  return runQuery<GalleryRow>(db, SELECT_GALLERY_PAGE, [
    requireUuid(input.parentProfileId, "parentProfileId"),
    input.cursor?.createdAt ?? null,
    input.cursor ? requireUuid(input.cursor.id, "cursorId") : null,
    input.limitPlusOne,
  ]);
}

export interface OwnedSourceAsset {
  path: string;
  mime_type: string | null;
  original_filename: string | null;
}

const SELECT_OWNED_SOURCE = `
  SELECT m.file_url AS path, m.mime_type, m.original_filename
  FROM public.media_assets m
  JOIN public.orders o ON o.id = m.order_id
  WHERE m.id = $1 AND o.parent_id = $2 AND m.type = 'upload' AND m.asset_role = 'source' AND m.file_url <> ''`;

/** A gallery asset the PROFILE owns (for re-use as a new request's source), or null: foreign and missing look the same. */
export async function findOwnedSourceAsset(
  db: Queryable,
  input: { parentProfileId: string; assetId: string },
): Promise<OwnedSourceAsset | null> {
  const rows = await runQuery<OwnedSourceAsset>(db, SELECT_OWNED_SOURCE, [
    requireUuid(input.assetId, "assetId"),
    requireUuid(input.parentProfileId, "parentProfileId"),
  ]);
  return rows[0] ?? null;
}

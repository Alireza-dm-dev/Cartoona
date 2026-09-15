import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderType } from "@/types/app";
import type {
  ParentDetailRow,
  ParentOrderDetail,
  ParentOrderDetailResult,
  ParentSourceMedia,
} from "./detail-types";
import { toParentOrderStatus } from "./status-mapping";
import { toParentClosure, toParentTimeline, type RawHistoryRow } from "./timeline-mapping";
import { isKnownOrderType } from "./type-mapping";
import { createPrivateSignedUrl } from "@/lib/storage/private-signed-url";

/**
 * Columns read for the detail page. Listed explicitly for the same reason as
 * the list query: a future column on `orders` must not widen what a parent
 * sees by default. `assigned_admin_id` and `moderation_status` are absent.
 */
const DETAIL_COLUMNS =
  "id, type, status, title, description, candy_cost, created_at, updated_at, characters(name)";

const NOT_RECORDED = "ثبت نشده";

/**
 * Order ids are UUIDs. A malformed id is rejected here rather than sent to
 * Postgres, which would raise a type error and surface as a read failure. A
 * bad id is simply not found, which is also what a probe should see.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidOrderId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

interface RawDetailRow {
  id: unknown;
  type: unknown;
  status: unknown;
  title: unknown;
  description: unknown;
  candy_cost: unknown;
  created_at: unknown;
  updated_at: unknown;
  characters?: { name?: unknown } | { name?: unknown }[] | null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function characterName(row: RawDetailRow): string | null {
  const c = Array.isArray(row.characters) ? row.characters[0] : row.characters;
  return text(c?.name);
}

/**
 * Build the type-specific rows.
 *
 * Only columns that exist today are used. Image orders have no detail table,
 * so they are described by the character and the parent's own brief. Video
 * uses `video_requests`, drawing animation uses `drawing_animation_requests`.
 * Nothing here invents a field the schema cannot supply.
 *
 * Exported for unit testing.
 */
export function buildDetailRows(input: {
  type: OrderType;
  characterName: string | null;
  video: { script?: unknown; style?: unknown; duration_seconds?: unknown } | null;
  drawing: { animation_style?: unknown } | null;
  hasSourceMedia: boolean;
}): ParentDetailRow[] {
  const rows: ParentDetailRow[] = [];

  if (input.type === "image") {
    rows.push({ label: "شخصیت", value: input.characterName ?? NOT_RECORDED });
  }

  if (input.type === "video") {
    rows.push({ label: "شخصیت", value: input.characterName ?? NOT_RECORDED });
    rows.push({ label: "سبک ویدیو", value: text(input.video?.style) ?? NOT_RECORDED });
    const seconds = typeof input.video?.duration_seconds === "number" ? input.video.duration_seconds : null;
    rows.push({
      label: "مدت زمان",
      // Persian digits, matching every other number on the page.
      value:
        seconds && seconds > 0
          ? `${new Intl.NumberFormat("fa-IR").format(seconds)} ثانیه`
          : NOT_RECORDED,
    });
    rows.push({
      label: "سناریو",
      value: text(input.video?.script) ?? NOT_RECORDED,
      multiline: true,
    });
  }

  if (input.type === "drawing_animation") {
    rows.push({
      label: "سبک انیمیشن",
      value: text(input.drawing?.animation_style) ?? NOT_RECORDED,
    });
    rows.push({
      label: "نقاشی منبع",
      value: input.hasSourceMedia ? "بارگذاری شده" : "بارگذاری نشده",
    });
  }

  return rows;
}

/**
 * One request belonging to the signed-in parent, with its timeline.
 *
 * Ownership is enforced three times over. The order query filters on both the
 * order id and the resolved `parent_id`, so another parent's row is never
 * returned to this process. Row level security applies the same rule
 * independently on the anon key. And the history function re-checks ownership
 * inside the database before returning a single row.
 *
 * A row belonging to someone else is reported as `not_found`, identical to an
 * id that does not exist, so the page cannot be used to probe whether another
 * parent's order is real.
 */
export async function getParentOrderDetail(
  supabase: SupabaseClient,
  orderId: string,
): Promise<ParentOrderDetailResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return { ok: false, reason: "unauthenticated" };

  if (!isValidOrderId(orderId)) return { ok: false, reason: "not_found" };

  const { data: profile, error: profileError } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) return { ok: false, reason: "read_failed" };
  if (!profile?.id) return { ok: false, reason: "no_parent_profile" };

  const { data, error } = await supabase
    .from("orders")
    .select(DETAIL_COLUMNS)
    .eq("id", orderId)
    .eq("parent_id", profile.id)
    .maybeSingle();

  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "not_found" };

  const row = data as unknown as RawDetailRow;

  const requestType = typeof row.type === "string" ? row.type : null;
  if (!isKnownOrderType(requestType)) return { ok: false, reason: "not_found" };

  const status = toParentOrderStatus(typeof row.status === "string" ? row.status : null);
  // A request still in a pre-submission state has no parent-facing detail
  // page, matching the list which does not show it either.
  if (status === null) return { ok: false, reason: "not_found" };

  if (typeof row.id !== "string" || typeof row.created_at !== "string") {
    return { ok: false, reason: "read_failed" };
  }

  // Type-specific extension row. Both tables are scoped to the parent's own
  // orders by row level security.
  let video: { script?: unknown; style?: unknown; duration_seconds?: unknown } | null = null;
  let drawing: { animation_style?: unknown } | null = null;

  if (requestType === "video") {
    const { data: v } = await supabase
      .from("video_requests")
      .select("script, style, duration_seconds")
      .eq("order_id", row.id)
      .maybeSingle();
    video = v ?? null;
  } else if (requestType === "drawing_animation") {
    const { data: d } = await supabase
      .from("drawing_animation_requests")
      .select("animation_style")
      .eq("order_id", row.id)
      .maybeSingle();
    drawing = d ?? null;
  }

  // Parent-uploaded source media only. Generated assets are filtered out at
  // the query, so a deliverable cannot reach this page even by accident.
  const { data: assets } = await supabase
    .from("media_assets")
    .select("id, type, file_url, mime_type, created_at")
    .eq("order_id", row.id)
    .eq("type", "upload")
    .order("created_at", { ascending: true });

  const sourceMedia: ParentSourceMedia[] = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    const path = typeof asset.file_url === "string" ? asset.file_url : null;
    if (!path) continue;
    const mimeType = typeof asset.mime_type === "string" ? asset.mime_type : null;
    // The signed URL is short-lived and generated per render. The storage path
    // it was built from never leaves this function.
    const signedUrl = await createPrivateSignedUrl(supabase, path);
    sourceMedia.push({
      id: String(asset.id),
      mimeType,
      uploadedAt: typeof asset.created_at === "string" ? asset.created_at : row.created_at,
      signedUrl,
      isImage: mimeType?.startsWith("image/") ?? false,
    });
  }

  // Parent-safe history. The function raises when the order is not the
  // caller's, which this treats as an empty timeline rather than an error:
  // ownership was already proven above, so a raise here means the history is
  // unavailable, not that the page should fail.
  let history: RawHistoryRow[] = [];
  const { data: historyRows } = await supabase.rpc("get_parent_order_status_history", {
    p_order_id: row.id,
  });
  if (Array.isArray(historyRows)) history = historyRows as RawHistoryRow[];

  const candyRaw = typeof row.candy_cost === "number" ? row.candy_cost : 0;
  const candyCost = Number.isFinite(candyRaw) && candyRaw > 0 ? Math.trunc(candyRaw) : 0;

  const detail: ParentOrderDetail = {
    id: row.id,
    requestType,
    createdAt: row.created_at,
    displayTitle: text(row.title) ?? "درخواست بدون عنوان",
    status,
    candyCost,
    completedAt: status === "ready" && typeof row.updated_at === "string" ? row.updated_at : null,
    description: text(row.description),
    detailRows: buildDetailRows({
      type: requestType,
      characterName: characterName(row),
      video,
      drawing,
      hasSourceMedia: sourceMedia.length > 0,
    }),
    timeline: toParentTimeline(history),
    closure: toParentClosure(history),
    sourceMedia,
  };

  return { ok: true, detail };
}

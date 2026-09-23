import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderType } from "@/types/app";
import type {
  ParentDetailRow,
  ParentFinalMedia,
  ParentOrderDetail,
  ParentOrderDetailResult,
  ParentSourceMedia,
} from "./detail-types";
import { toParentOrderStatus } from "./status-mapping";
import { deliveredAt, toParentClosure, toParentTimeline, type RawHistoryRow } from "./timeline-mapping";
import { isKnownOrderType } from "./type-mapping";
import { createPrivateSignedUrl } from "@/lib/storage/private-signed-url";
import { mapVideoDurationLabel } from "@/lib/pricing/pricing-keys";
import { resolveCurrentParentFinalMedia } from "./final-media-queries";

/**
 * Columns read for the detail page. Listed explicitly for the same reason as
 * the list query: a future column on `orders` must not widen what a parent
 * sees by default. `assigned_admin_id` and `moderation_status` are absent.
 */
const DETAIL_COLUMNS =
  "id, type, status, title, description, child_name, candy_cost, created_at, characters(name)";

const NOT_RECORDED = "ثبت نشده";
/**
 * Used where a request predates the field entirely. Distinct from
 * NOT_RECORDED: nothing is inferred for a historical row.
 */
const NOT_SPECIFIED = "مشخص نشده";

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
  child_name: unknown;
  candy_cost: unknown;
  created_at: unknown;
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
  video: {
    script?: unknown;
    style?: unknown;
    duration_seconds?: unknown;
    duration_choice?: unknown;
    characters_speak?: unknown;
  } | null;
  drawing: { animation_style?: unknown } | null;
  hasSourceMedia: boolean;
  /**
   * Optional child name from the request. Absent for every request made
   * before the field existed and for every parent who left it blank, and in
   * both cases no row is produced rather than one reading "ثبت نشده".
   */
  childName?: unknown;
}): ParentDetailRow[] {
  const rows: ParentDetailRow[] = [];
  const childName = text(input.childName);

  if (input.type === "image") {
    rows.push({ label: "شخصیت", value: input.characterName ?? NOT_RECORDED });
    if (childName !== null) {
      rows.push({ label: "نام کودک", value: childName });
    }
  }

  if (input.type === "video") {
    rows.push({ label: "شخصیت", value: input.characterName ?? NOT_RECORDED });
    if (childName !== null) {
      rows.push({ label: "نام کودک", value: childName });
    }

    // Style is no longer collected. The row appears only for the historical
    // requests that already carry one, so new requests show no empty row.
    const style = text(input.video?.style);
    if (style !== null) {
      rows.push({ label: "سبک ویدیو", value: style });
    }

    // The parent-facing choice when there is one, otherwise the raw seconds a
    // historical row may carry. Neither is invented from the other.
    const choiceLabel = mapVideoDurationLabel(input.video?.duration_choice);
    const seconds =
      typeof input.video?.duration_seconds === "number" ? input.video.duration_seconds : null;
    rows.push({
      label: "مدت تقریبی",
      value:
        choiceLabel ??
        // Persian digits, matching every other number on the page.
        (seconds && seconds > 0
          ? `${new Intl.NumberFormat("fa-IR").format(seconds)} ثانیه`
          : NOT_SPECIFIED),
    });

    rows.push({
      label: "صحبت کردن کاراکترها",
      value:
        typeof input.video?.characters_speak === "boolean"
          ? input.video.characters_speak
            ? "بله"
            : "خیر"
          : NOT_SPECIFIED,
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
  let video: {
    script?: unknown;
    style?: unknown;
    duration_seconds?: unknown;
    duration_choice?: unknown;
    characters_speak?: unknown;
  } | null = null;
  let drawing: { animation_style?: unknown } | null = null;

  if (requestType === "video") {
    const { data: v } = await supabase
      .from("video_requests")
      .select("script, style, duration_seconds, duration_choice, characters_speak")
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

  // Metadata only — never a signed URL here. The page decides which panel to
  // render from this alone; the actual preview/download link is minted on
  // demand by the dedicated endpoint, never persisted or embedded in SSR HTML.
  const finalRow = await resolveCurrentParentFinalMedia(supabase, row.id);
  const finalMedia: ParentFinalMedia | null = finalRow
    ? { id: finalRow.id, mimeType: finalRow.mimeType, fileName: finalRow.fileName }
    : null;

  const candyRaw = typeof row.candy_cost === "number" ? row.candy_cost : 0;
  const candyCost = Number.isFinite(candyRaw) && candyRaw > 0 ? Math.trunc(candyRaw) : 0;

  const detail: ParentOrderDetail = {
    id: row.id,
    requestType,
    createdAt: row.created_at,
    displayTitle: text(row.title) ?? "درخواست بدون عنوان",
    status,
    candyCost,
    // The real delivered transition, not a proxy off orders.updated_at (which
    // is touched by every status change, not only this one).
    completedAt: deliveredAt(history),
    description: text(row.description),
    detailRows: buildDetailRows({
      type: requestType,
      characterName: characterName(row),
      video,
      drawing,
      hasSourceMedia: sourceMedia.length > 0,
      childName: row.child_name,
    }),
    timeline: toParentTimeline(history),
    closure: toParentClosure(history),
    sourceMedia,
    finalMedia,
  };

  return { ok: true, detail };
}

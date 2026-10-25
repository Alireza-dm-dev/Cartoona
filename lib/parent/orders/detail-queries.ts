import type { OrderType } from "@/types/app";
import type {
  ParentDetailRow,
  ParentFinalMedia,
  ParentOrderDetail,
  ParentSourceMedia,
} from "./detail-types";
import { toParentOrderStatus } from "./status-mapping";
import { deliveredAt, toParentClosure, toParentTimeline, type RawHistoryRow } from "./timeline-mapping";
import { isKnownOrderType } from "./type-mapping";
import { mapVideoDurationLabel } from "@/lib/pricing/pricing-keys";

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

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
 * What the backend returns for one of the caller's own orders (V0.1.52): the
 * metadata rows of GET /v1/parent/orders/:orderId, already filtered by
 * ownership in PostgreSQL. `sourceMedia[].path` is a storage KEY used only to
 * sign (see backend-order-detail.ts) and is dropped here.
 */
export interface BackendOrderDetail {
  order: {
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
  };
  sourceMedia: Array<{ id: string; mimeType: string | null; uploadedAt: string; path: string }>;
  history: RawHistoryRow[];
  finalMedia: ParentFinalMedia | null;
}

/**
 * Builds the parent page model from the backend rows and the signed-URL map
 * (path -> URL | null). Pure: no I/O. A request still in a pre-submission
 * state has no parent-facing page (matching the list), reported as null.
 */
export function assembleParentOrderDetail(
  data: BackendOrderDetail,
  signed: Map<string, string | null>,
): ParentOrderDetail | null {
  const row = data.order;
  if (!isKnownOrderType(row.type)) return null;
  const requestType = row.type;
  const status = toParentOrderStatus(row.status);
  if (status === null) return null;

  const sourceMedia: ParentSourceMedia[] = data.sourceMedia.map((asset) => ({
    id: asset.id,
    mimeType: asset.mimeType,
    uploadedAt: asset.uploadedAt,
    signedUrl: signed.get(asset.path) ?? null,
    isImage: asset.mimeType?.startsWith("image/") ?? false,
  }));

  const candyRaw = row.candy_cost;
  const candyCost = Number.isFinite(candyRaw) && candyRaw > 0 ? Math.trunc(candyRaw) : 0;

  return {
    id: row.id,
    requestType,
    createdAt: row.created_at,
    displayTitle: text(row.title) ?? "درخواست بدون عنوان",
    status,
    candyCost,
    // The real delivered transition, not a proxy off orders.updated_at.
    completedAt: deliveredAt(data.history),
    description: text(row.description),
    detailRows: buildDetailRows({
      type: requestType,
      characterName: text(row.character_name),
      video: requestType === "video"
        ? {
            script: row.video_script,
            style: row.video_style,
            duration_seconds: row.video_duration_seconds,
            duration_choice: row.video_duration_choice,
            characters_speak: row.video_characters_speak,
          }
        : null,
      drawing: requestType === "drawing_animation" ? { animation_style: row.drawing_animation_style } : null,
      hasSourceMedia: sourceMedia.length > 0,
      childName: row.child_name,
    }),
    timeline: toParentTimeline(data.history),
    closure: toParentClosure(data.history),
    sourceMedia,
    finalMedia: data.finalMedia,
  };
}

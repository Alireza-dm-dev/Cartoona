import { describe, it, expect } from "vitest";
import {
  CLOSURE_FALLBACK_REASON,
  CLOSURE_LABELS,
  TIMELINE_LABELS,
  closureReasonText,
  toParentClosure,
  toParentTimeline,
  type RawHistoryRow,
} from "@/lib/parent/orders/timeline-mapping";
import { buildDetailRows } from "@/lib/parent/orders/detail-queries";
import { ALL_ORDER_STATUSES } from "@/lib/admin/requests/workflow";

/**
 * Pure layers behind /dashboard/orders/[orderId]: the history→timeline
 * mapping, the rejected/cancelled closure block, and the type-aware detail
 * rows. The query itself is covered by the guarded stateful spec.
 */

const h = (over: Partial<RawHistoryRow> = {}): RawHistoryRow => ({
  previous_status: "pending_review",
  new_status: "in_progress",
  parent_visible_note: null,
  created_at: "2026-03-01T10:00:00.000Z",
  ...over,
});

describe("timeline mapping", () => {
  it("maps workflow transitions to parent-facing steps", () => {
    const events = toParentTimeline([
      h({ new_status: "pending_review", created_at: "2026-01-01T00:00:00.000Z" }),
      h({ new_status: "in_progress", created_at: "2026-02-01T00:00:00.000Z" }),
      h({ new_status: "ready", created_at: "2026-03-01T00:00:00.000Z" }),
      h({ new_status: "delivered", created_at: "2026-04-01T00:00:00.000Z" }),
    ]);
    expect(events.map((e) => e.status)).toEqual(["ready", "final_review", "creating", "submitted"]);
  });

  it("orders newest first regardless of input order", () => {
    const events = toParentTimeline([
      h({ new_status: "in_progress", created_at: "2026-02-01T00:00:00.000Z" }),
      h({ new_status: "delivered", created_at: "2026-04-01T00:00:00.000Z" }),
      h({ new_status: "pending_review", created_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(events.map((e) => e.at)).toEqual([
      "2026-04-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("drops pre-submission and unrecognised statuses", () => {
    const events = toParentTimeline([
      h({ new_status: "draft" }),
      h({ new_status: "pending_payment" }),
      h({ new_status: "teleported" }),
      h({ new_status: null }),
    ]);
    expect(events).toEqual([]);
  });

  it("never renders a raw internal status as a label", () => {
    const labels = Object.values(TIMELINE_LABELS);
    for (const internal of ALL_ORDER_STATUSES) {
      expect(labels).not.toContain(internal);
    }
  });

  it("carries the parent-visible note and nothing else", () => {
    const [event] = toParentTimeline([
      h({
        parent_visible_note: "نقاشی شما دریافت شد",
        // Fields the database function never returns; present here to prove
        // the mapper would ignore them even if they somehow arrived.
        internal_note: "ADMIN ONLY: escalate to supervisor",
        changed_by_user_id: "admin-uuid",
      } as RawHistoryRow),
    ]);
    expect(event.note).toBe("نقاشی شما دریافت شد");
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("ADMIN ONLY");
    expect(serialized).not.toContain("admin-uuid");
    expect(Object.keys(event).sort()).toEqual(["at", "note", "status"]);
  });

  it("treats a blank note as absent", () => {
    expect(toParentTimeline([h({ parent_visible_note: "   " })])[0].note).toBeNull();
    expect(toParentTimeline([h({ parent_visible_note: 42 })])[0].note).toBeNull();
  });
});

describe("rejected vs cancelled", () => {
  it("distinguishes the two terminal states", () => {
    expect(toParentClosure([h({ new_status: "rejected" })])?.kind).toBe("rejected");
    expect(toParentClosure([h({ new_status: "cancelled" })])?.kind).toBe("cancelled");
    expect(CLOSURE_LABELS.rejected).toBe("رد شده");
    expect(CLOSURE_LABELS.cancelled).toBe("لغو شده");
  });

  it("returns null for a request that has not ended", () => {
    expect(toParentClosure([h({ new_status: "in_progress" }), h({ new_status: "ready" })])).toBeNull();
  });

  it("uses the parent-visible note as the reason when one exists", () => {
    const closure = toParentClosure([
      h({ new_status: "rejected", parent_visible_note: "تصویر ارسالی واضح نبود" }),
    ]);
    expect(closure?.reason).toBe("تصویر ارسالی واضح نبود");
    expect(closureReasonText(closure!)).toBe("تصویر ارسالی واضح نبود");
  });

  it("falls back to a neutral sentence rather than the internal note", () => {
    const closure = toParentClosure([
      h({
        new_status: "rejected",
        parent_visible_note: null,
        internal_note: "ADMIN ONLY: duplicate of #42",
      } as RawHistoryRow),
    ]);
    expect(closure?.reason).toBeNull();
    expect(closureReasonText(closure!)).toBe(CLOSURE_FALLBACK_REASON.rejected);
    expect(closureReasonText(closure!)).not.toContain("ADMIN ONLY");
  });

  it("takes the most recent terminal row when several exist", () => {
    const closure = toParentClosure([
      h({ new_status: "rejected", created_at: "2026-01-01T00:00:00.000Z" }),
      h({ new_status: "cancelled", created_at: "2026-05-01T00:00:00.000Z" }),
    ]);
    expect(closure?.kind).toBe("cancelled");
  });
});

describe("type-aware detail rows", () => {
  const base = { characterName: "داینو دودو", video: null, drawing: null, hasSourceMedia: false };

  it("describes an image request by its character", () => {
    const rows = buildDetailRows({ ...base, type: "image" });
    expect(rows.map((r) => r.label)).toEqual(["شخصیت"]);
    expect(rows[0].value).toBe("داینو دودو");
  });

  it("uses only video columns that exist in the schema", () => {
    const rows = buildDetailRows({
      ...base,
      type: "video",
      video: { script: "یک ماجرای جنگلی", style: "سه‌بعدی", duration_seconds: 30 },
    });
    expect(rows.map((r) => r.label)).toEqual(["شخصیت", "سبک ویدیو", "مدت زمان", "سناریو"]);
    expect(rows.find((r) => r.label === "مدت زمان")?.value).toBe(
      `${new Intl.NumberFormat("fa-IR").format(30)} ثانیه`,
    );
    // There is no genre column in the schema, so no such row may appear.
    expect(rows.map((r) => r.label)).not.toContain("ژانر");
  });

  it("reports drawing source presence without exposing a path", () => {
    const rows = buildDetailRows({
      ...base,
      type: "drawing_animation",
      drawing: { animation_style: "کلاسیک" },
      hasSourceMedia: true,
    });
    expect(rows.map((r) => r.label)).toEqual(["سبک انیمیشن", "نقاشی منبع"]);
    expect(rows.find((r) => r.label === "نقاشی منبع")?.value).toBe("بارگذاری شده");
    expect(JSON.stringify(rows)).not.toContain("parent-uploads");
  });

  it("falls back to a Persian placeholder for missing values", () => {
    const rows = buildDetailRows({
      ...base,
      type: "video",
      characterName: null,
      video: { script: null, style: null, duration_seconds: 0 },
    });
    for (const row of rows) expect(row.value).toBe("ثبت نشده");
  });
});

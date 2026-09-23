import { describe, it, expect } from "vitest";
import {
  CLOSURE_FALLBACK_REASON,
  CLOSURE_LABELS,
  TIMELINE_LABELS,
  closureReasonText,
  deliveredAt,
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

describe("deliveredAt — completedAt derived from the real transition", () => {
  it("returns null when the order was never delivered", () => {
    expect(deliveredAt([h({ new_status: "in_progress" }), h({ new_status: "ready" })])).toBeNull();
  });

  it("returns the delivered row's own timestamp, not just any row's", () => {
    const at = deliveredAt([
      h({ new_status: "pending_review", created_at: "2026-01-01T00:00:00.000Z" }),
      h({ new_status: "delivered", created_at: "2026-04-05T12:30:00.000Z" }),
    ]);
    expect(at).toBe("2026-04-05T12:30:00.000Z");
  });

  it("ignores unrelated statuses that happen to share the word, e.g. ready", () => {
    // The internal `delivered` value, never the parent-facing "ready" label
    // it maps to — history rows are read raw here, before translation.
    expect(deliveredAt([h({ new_status: "ready", created_at: "2026-01-01T00:00:00.000Z" })])).toBeNull();
  });

  it("is not fooled by a later, unrelated status change", () => {
    // A hypothetical future transition after delivered must not read as a
    // fresher "completion" than the delivery itself.
    const at = deliveredAt([
      h({ new_status: "delivered", created_at: "2026-02-01T00:00:00.000Z" }),
      h({ new_status: "in_progress", created_at: "2026-03-01T00:00:00.000Z" }),
    ]);
    expect(at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("takes the earliest delivered row if more than one somehow exists", () => {
    const at = deliveredAt([
      h({ new_status: "delivered", created_at: "2026-05-01T00:00:00.000Z" }),
      h({ new_status: "delivered", created_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(at).toBe("2026-01-01T00:00:00.000Z");
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

  it("shows the child name when the request carries one", () => {
    const imageRows = buildDetailRows({ ...base, type: "image", childName: "آریا" });
    expect(imageRows).toContainEqual({ label: "نام کودک", value: "آریا" });

    const videoRows = buildDetailRows({
      ...base,
      type: "video",
      video: { script: "یک ماجرا", style: null, duration_seconds: null, duration_choice: "5_10", characters_speak: true },
      childName: "آریا",
    });
    expect(videoRows).toContainEqual({ label: "نام کودک", value: "آریا" });
  });

  it("omits the child-name row entirely when there is none", () => {
    // Requests created before the column existed carry null here, and must not
    // gain a row reading "ثبت نشده".
    for (const childName of [undefined, null, "", "   "]) {
      const rows = buildDetailRows({ ...base, type: "image", childName });
      expect(rows.some((r) => r.label === "نام کودک")).toBe(false);
    }
  });

  it("shows duration and speech for a new video request, and no style row", () => {
    const rows = buildDetailRows({
      ...base,
      type: "video",
      video: {
        script: "یک ماجرای جنگلی",
        style: null,
        duration_seconds: null,
        duration_choice: "10_20",
        characters_speak: true,
      },
    });
    expect(rows.map((r) => r.label)).toEqual([
      "شخصیت",
      "مدت تقریبی",
      "صحبت کردن کاراکترها",
      "سناریو",
    ]);
    expect(rows.find((r) => r.label === "مدت تقریبی")?.value).toBe("۱۰ تا ۲۰ ثانیه");
    expect(rows.find((r) => r.label === "صحبت کردن کاراکترها")?.value).toBe("بله");
    // Removed fields must not reappear as empty rows.
    expect(rows.map((r) => r.label)).not.toContain("سبک ویدیو");
    expect(rows.map((r) => r.label)).not.toContain("عنوان ویدیو");
  });

  it("renders each duration choice with its Persian label", () => {
    const labelFor = (choice: string) =>
      buildDetailRows({
        ...base,
        type: "video",
        video: { duration_choice: choice, characters_speak: false },
      }).find((r) => r.label === "مدت تقریبی")?.value;

    expect(labelFor("5_10")).toBe("۵ تا ۱۰ ثانیه");
    expect(labelFor("10_20")).toBe("۱۰ تا ۲۰ ثانیه");
    expect(labelFor("30_plus")).toBe("بیش از ۳۰ ثانیه");
  });

  it("shows خیر when the parent chose no speech", () => {
    const rows = buildDetailRows({
      ...base,
      type: "video",
      video: { duration_choice: "5_10", characters_speak: false },
    });
    expect(rows.find((r) => r.label === "صحبت کردن کاراکترها")?.value).toBe("خیر");
  });

  it("keeps a historical request readable: style shown, missing fields neutral", () => {
    const rows = buildDetailRows({
      ...base,
      type: "video",
      video: {
        script: "یک ماجرای جنگلی",
        style: "سه‌بعدی",
        duration_seconds: 30,
        duration_choice: null,
        characters_speak: null,
      },
    });
    expect(rows.map((r) => r.label)).toEqual([
      "شخصیت",
      "سبک ویدیو",
      "مدت تقریبی",
      "صحبت کردن کاراکترها",
      "سناریو",
    ]);
    expect(rows.find((r) => r.label === "سبک ویدیو")?.value).toBe("سه‌بعدی");
    expect(rows.find((r) => r.label === "مدت تقریبی")?.value).toBe(
      `${new Intl.NumberFormat("fa-IR").format(30)} ثانیه`,
    );
    // A null speech flag is never inferred either way.
    expect(rows.find((r) => r.label === "صحبت کردن کاراکترها")?.value).toBe("مشخص نشده");
    // There is no genre column in the schema, so no such row may appear.
    expect(rows.map((r) => r.label)).not.toContain("ژانر");
  });

  it("rejects an unknown duration value rather than displaying it", () => {
    const rows = buildDetailRows({
      ...base,
      type: "video",
      video: { duration_choice: "20_30", characters_speak: true },
    });
    const duration = rows.find((r) => r.label === "مدت تقریبی")?.value;
    expect(duration).toBe("مشخص نشده");
    expect(duration).not.toContain("20_30");
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
    for (const row of rows) {
      expect(["ثبت نشده", "مشخص نشده"]).toContain(row.value);
    }
  });
});

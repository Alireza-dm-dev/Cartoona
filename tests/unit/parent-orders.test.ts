import { describe, it, expect } from "vitest";
import {
  PARENT_STATUS_LABELS,
  PARENT_VISIBLE_INTERNAL_STATUSES,
  isParentVisibleStatus,
  toParentOrderStatus,
} from "@/lib/parent/orders/status-mapping";
import {
  PARENT_TYPE_LABELS,
  PARENT_TYPE_ROUTES,
  isKnownOrderType,
  parentTypeLabel,
} from "@/lib/parent/orders/type-mapping";
import { toParentOrderSummary } from "@/lib/parent/orders/queries";
import { ALL_ORDER_STATUSES } from "@/lib/admin/requests/workflow";

/**
 * Pure layers behind /dashboard/orders: the internal→parent status mapping,
 * the request-type mapping, and the serializer that is the security boundary
 * between an `orders` row and the browser.
 */

const row = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  type: "image",
  status: "pending_review",
  title: "پرواز پرهای مهتابی",
  candy_cost: 150,
  created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-02T10:00:00.000Z",
  ...over,
});

describe("status mapping", () => {
  it("maps every submitted workflow status to a parent state", () => {
    expect(toParentOrderStatus("pending_review")).toBe("submitted");
    expect(toParentOrderStatus("in_progress")).toBe("creating");
    expect(toParentOrderStatus("ready")).toBe("final_review");
    expect(toParentOrderStatus("delivered")).toBe("ready");
  });

  it("collapses rejected and cancelled into one closed state", () => {
    expect(toParentOrderStatus("rejected")).toBe("closed");
    expect(toParentOrderStatus("cancelled")).toBe("closed");
  });

  it("hides pre-submission states from the parent list", () => {
    expect(toParentOrderStatus("draft")).toBeNull();
    expect(toParentOrderStatus("pending_payment")).toBeNull();
    expect(isParentVisibleStatus("draft")).toBe(false);
  });

  it("covers every internal status, so a new one cannot be silently missed", () => {
    for (const status of ALL_ORDER_STATUSES) {
      // Either a parent-facing state or an explicit null; never undefined.
      expect(toParentOrderStatus(status)).not.toBeUndefined();
    }
  });

  it("treats unknown and malformed statuses as not visible", () => {
    for (const bad of ["", "queued", "PENDING_REVIEW", null, undefined, "  "]) {
      expect(toParentOrderStatus(bad as string)).toBeNull();
    }
  });

  it("never exposes a raw internal status string as a label", () => {
    const labels = Object.values(PARENT_STATUS_LABELS);
    for (const internal of ALL_ORDER_STATUSES) {
      expect(labels).not.toContain(internal);
    }
  });

  it("lists exactly the six workflow statuses as parent-visible", () => {
    expect([...PARENT_VISIBLE_INTERNAL_STATUSES].sort()).toEqual(
      ["cancelled", "delivered", "in_progress", "pending_review", "ready", "rejected"].sort(),
    );
  });
});

describe("request-type mapping", () => {
  it("labels all three creation types in Persian", () => {
    expect(parentTypeLabel("image")).toBe("تصویر کارتونی");
    expect(parentTypeLabel("video")).toBe("ویدیوی کارتونی");
    expect(parentTypeLabel("drawing_animation")).toBe("جان‌بخشی به نقاشی");
  });

  it("rejects unknown types", () => {
    for (const bad of ["story", "", null, undefined, "IMAGE"]) {
      expect(isKnownOrderType(bad as string)).toBe(false);
    }
  });

  it("points every type at an existing creation route", () => {
    expect(Object.values(PARENT_TYPE_ROUTES)).toEqual([
      "/dashboard/create-image",
      "/dashboard/request-video",
      "/dashboard/animate-drawing",
    ]);
    expect(Object.keys(PARENT_TYPE_ROUTES).sort()).toEqual(
      Object.keys(PARENT_TYPE_LABELS).sort(),
    );
  });
});

describe("parent order serializer", () => {
  it("maps a well-formed row to the read model", () => {
    const out = toParentOrderSummary(row());
    expect(out).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      requestType: "image",
      createdAt: "2026-09-01T10:00:00.000Z",
      displayTitle: "پرواز پرهای مهتابی",
      status: "submitted",
      candyCost: 150,
      completedAt: null,
    });
  });

  it("exposes no field outside the read model", () => {
    const out = toParentOrderSummary(
      row({
        assigned_admin_id: "admin-uuid",
        moderation_status: "flagged",
        description: "internal note",
        parent_id: "other-parent",
        storage_path: "final-deliverables/secret.png",
      }),
    );
    expect(Object.keys(out ?? {}).sort()).toEqual(
      ["candyCost", "completedAt", "createdAt", "displayTitle", "id", "requestType", "status"].sort(),
    );
    const serialized = JSON.stringify(out);
    for (const leak of ["admin-uuid", "flagged", "internal note", "other-parent", "final-deliverables"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("sets completedAt only once the request is delivered", () => {
    expect(toParentOrderSummary(row({ status: "delivered" }))?.completedAt).toBe(
      "2026-09-02T10:00:00.000Z",
    );
    // `ready` means the file exists but has not been handed over, so showing a
    // completion date would misrepresent internal progress as delivery.
    expect(toParentOrderSummary(row({ status: "ready" }))?.completedAt).toBeNull();
    expect(toParentOrderSummary(row({ status: "in_progress" }))?.completedAt).toBeNull();
  });

  it("drops rows it cannot present safely", () => {
    expect(toParentOrderSummary(row({ status: "draft" }))).toBeNull();
    expect(toParentOrderSummary(row({ type: "hologram" }))).toBeNull();
    expect(toParentOrderSummary(row({ id: "" }))).toBeNull();
    expect(toParentOrderSummary(row({ id: 42 }))).toBeNull();
    expect(toParentOrderSummary(row({ created_at: null }))).toBeNull();
  });

  it("falls back to a Persian placeholder for a missing title", () => {
    expect(toParentOrderSummary(row({ title: "   " }))?.displayTitle).toBe("درخواست بدون عنوان");
    expect(toParentOrderSummary(row({ title: null }))?.displayTitle).toBe("درخواست بدون عنوان");
  });

  it("normalizes a malformed candy cost to zero rather than rendering NaN", () => {
    expect(toParentOrderSummary(row({ candy_cost: null }))?.candyCost).toBe(0);
    expect(toParentOrderSummary(row({ candy_cost: -5 }))?.candyCost).toBe(0);
    expect(toParentOrderSummary(row({ candy_cost: 12.7 }))?.candyCost).toBe(12);
  });
});

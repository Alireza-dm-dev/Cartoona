import { describe, test, expect } from "vitest";
import {
  toAdminFinalMediaInfo,
  toAdminHistoryItem,
  toParentFinalAssetInfo,
  toParentHistoryItem,
  parseAdminStatusUpdateInput,
} from "@/lib/admin/requests/fulfilment-types";

const finalRow = {
  id: "asset-1",
  file_url: "orders/o1/final/abc.png",
  mime_type: "image/png",
  byte_size: 2048,
  created_at: "2026-08-01T10:00:00Z",
  superseded_at: null,
  delivery_status: "uploaded",
  parent_visible: false,
};

describe("admin final media serializer", () => {
  test("never leaks the raw storage path", () => {
    const info = toAdminFinalMediaInfo(finalRow, "https://signed.example/x");
    expect(JSON.stringify(info)).not.toContain("orders/o1/final/abc.png");
    expect(info.fileName).toBe("abc.png");
    expect("file_url" in info).toBe(false);
  });

  test("preserves delivery status and visibility", () => {
    const info = toAdminFinalMediaInfo(finalRow, null);
    expect(info.deliveryStatus).toBe("uploaded");
    expect(info.parentVisible).toBe(false);
    expect(info.signedUrlFailed).toBe(true);
  });

  test("approved asset maps approved status", () => {
    const info = toAdminFinalMediaInfo(
      { ...finalRow, delivery_status: "approved", parent_visible: true },
      "https://signed.example/y",
    );
    expect(info.deliveryStatus).toBe("approved");
    expect(info.parentVisible).toBe(true);
  });

  test("superseded asset maps superseded status and keeps supersededAt", () => {
    const info = toAdminFinalMediaInfo(
      { ...finalRow, delivery_status: "superseded", superseded_at: "2026-08-01T12:00:00Z" },
      null,
    );
    expect(info.deliveryStatus).toBe("superseded");
    expect(info.supersededAt).toBe("2026-08-01T12:00:00Z");
  });
});

describe("parent-safe serializers", () => {
  test("only approved + parent-visible assets are exposed to parents", () => {
    expect(toParentFinalAssetInfo(finalRow, "https://signed.example/x")).toBeNull();
    expect(
      toParentFinalAssetInfo({ ...finalRow, delivery_status: "approved", parent_visible: true }, "https://signed.example/x"),
    ).not.toBeNull();
    expect(
      toParentFinalAssetInfo(
        { ...finalRow, delivery_status: "superseded", parent_visible: false },
        "https://signed.example/x",
      ),
    ).toBeNull();
  });

  test("parent asset model never leaks internal metadata", () => {
    const info = toParentFinalAssetInfo(
      { ...finalRow, delivery_status: "approved", parent_visible: true },
      "https://signed.example/x",
    );
    expect(info).not.toBeNull();
    const json = JSON.stringify(info);
    expect(json).not.toContain("orders/");
    expect(json).not.toContain("uploaded_by");
    expect(json).not.toContain("superseded");
    expect(json).not.toContain("parent_visible");
  });

  test("history item exposes parent-visible note only", () => {
    const item = toParentHistoryItem({
      previous_status: "pending_review",
      new_status: "in_progress",
      parent_visible_note: "در حال تولید",
      created_at: "2026-08-01T10:00:00Z",
    });
    expect(item.newStatus).toBe("in_progress");
    expect(item.parentVisibleNote).toBe("در حال تولید");
    expect("internalNote" in item).toBe(false);
  });

  test("unknown statuses in history fall back safely", () => {
    const item = toParentHistoryItem({
      previous_status: "bogus",
      new_status: "weird",
      parent_visible_note: null,
      created_at: "2026-08-01T10:00:00Z",
    });
    expect(item.previousStatus).toBeNull();
    expect(item.newStatus).toBe("pending_review");
  });
});

describe("admin history serializer", () => {
  test("keeps internal note for admins but never leaks raw DB column names", () => {
    const item = toAdminHistoryItem({
      id: "h-1",
      previous_status: "in_progress",
      new_status: "ready",
      changed_by: "admin@example.com",
      changed_by_deleted: false,
      internal_note: "فایل‌ها تأیید شد",
      parent_visible_note: "آماده تحویل است",
      created_at: "2026-08-01T10:00:00Z",
    });
    expect(item.internalNote).toBe("فایل‌ها تأیید شد");
    expect(item.changedBy).toBe("admin@example.com");
    const json = JSON.stringify(item);
    expect(json).not.toContain("changed_by_name");
    expect(json).not.toContain("internal_note");
  });

  test("deleted admin is reported without exposing user id", () => {
    const item = toAdminHistoryItem({
      id: "h-2",
      previous_status: null,
      new_status: "pending_review",
      changed_by: null,
      changed_by_deleted: true,
      internal_note: null,
      parent_visible_note: null,
      created_at: "2026-08-01T09:00:00Z",
    });
    expect(item.changedByDeleted).toBe(true);
    expect(item.changedBy).toBeNull();
    const json = JSON.stringify(item);
    expect(json).not.toContain("changed_by_user_id");
    expect(json).not.toContain("u-");
  });
});

describe("PATCH /status input parsing", () => {
  test("accepts a valid payload", () => {
    const r = parseAdminStatusUpdateInput({
      status: "in_progress",
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
      internalNote: "  تأیید شد  ",
      parentVisibleNote: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.status).toBe("in_progress");
      expect(r.input.internalNote).toBe("تأیید شد");
      expect(r.input.parentVisibleNote).toBeNull();
    }
  });

  test("rejects unknown status with 422", () => {
    const r = parseAdminStatusUpdateInput({
      status: "bogus",
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.code).toBe("REQUEST_INVALID_STATUS");
    }
  });

  test("rejects missing/invalid expectedUpdatedAt with 400", () => {
    const r = parseAdminStatusUpdateInput({ status: "ready", expectedUpdatedAt: "not-a-date" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test("rejects unexpected keys with 400", () => {
    const r = parseAdminStatusUpdateInput({
      status: "ready",
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
      evil: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("REQUEST_INVALID_BODY");
    }
  });

  test("rejects non-object bodies", () => {
    for (const raw of [null, undefined, "x", 5, []]) {
      const r = parseAdminStatusUpdateInput(raw);
      expect(r.ok).toBe(false);
    }
  });

  test("rejects notes longer than 2000 chars with 422", () => {
    const r = parseAdminStatusUpdateInput({
      status: "rejected",
      expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
      internalNote: "a".repeat(2001),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.code).toBe("REQUEST_NOTE_TOO_LONG");
    }
  });
});

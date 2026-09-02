import { describe, test, expect } from "vitest";
import {
  isKnownOrderType,
  isKnownOrderStatus,
  mapRequestTypeLabel,
  mapOrderStatusLabel,
  mapChildProfileLabel,
  mapParentInfo,
  parentDeletedLabel,
  mapMediaAsset,
  mapImageTypeRows,
  mapVideoTypeRows,
  mapDrawingTypeRows,
  mapOrderDetail,
  mapQueueRow,
} from "@/lib/admin/requests/mappers";
import {
  parseTypeFilter,
  parseStatusFilter,
  parsePageNumber,
  parsePageSize,
  clampPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "@/lib/admin/requests/validation";
import { adminRequestTypeLabels, UNKNOWN_REQUEST_TYPE_LABEL } from "@/config/admin";

describe("request type mapping", () => {
  test("maps known types to Persian", () => {
    expect(mapRequestTypeLabel("image")).toBe("تصویر");
    expect(mapRequestTypeLabel("video")).toBe("ویدیو");
    expect(mapRequestTypeLabel("drawing_animation")).toBe("انیمیشن نقاشی");
  });

  test("config labels match expected Persian values", () => {
    expect(adminRequestTypeLabels.image).toBe("تصویر");
    expect(adminRequestTypeLabels.video).toBe("ویدیو");
    expect(adminRequestTypeLabels.drawing_animation).toBe("انیمیشن نقاشی");
  });

  test("unknown type falls back safely", () => {
    expect(mapRequestTypeLabel("hologram")).toBe(UNKNOWN_REQUEST_TYPE_LABEL);
    expect(mapRequestTypeLabel(null)).toBe(UNKNOWN_REQUEST_TYPE_LABEL);
    expect(mapRequestTypeLabel(undefined)).toBe(UNKNOWN_REQUEST_TYPE_LABEL);
    expect(mapRequestTypeLabel("")).toBe(UNKNOWN_REQUEST_TYPE_LABEL);
  });

  test("isKnownOrderType guards correctly", () => {
    expect(isKnownOrderType("image")).toBe(true);
    expect(isKnownOrderType("hologram")).toBe(false);
    expect(isKnownOrderType(null)).toBe(false);
  });
});

describe("status mapping", () => {
  test("maps every known status to Persian", () => {
    expect(mapOrderStatusLabel("draft")).toBe("پیش‌نویس");
    expect(mapOrderStatusLabel("pending_payment")).toBe("در انتظار پرداخت");
    expect(mapOrderStatusLabel("pending_review")).toBe("در انتظار بررسی");
    expect(mapOrderStatusLabel("in_progress")).toBe("در حال انجام");
    expect(mapOrderStatusLabel("ready")).toBe("آماده تحویل");
    expect(mapOrderStatusLabel("delivered")).toBe("تحویل داده شده");
    expect(mapOrderStatusLabel("rejected")).toBe("رد شده");
    expect(mapOrderStatusLabel("cancelled")).toBe("لغو شده");
  });

  test("unknown status falls back safely", () => {
    expect(mapOrderStatusLabel("weird_state")).toBe("وضعیت نامشخص");
    expect(mapOrderStatusLabel(null)).toBe("وضعیت نامشخص");
    expect(isKnownOrderStatus("weird_state")).toBe(false);
  });
});

describe("parent and child privacy", () => {
  test("parent deleted state is safe", () => {
    const parent = mapParentInfo(null, null, true);
    expect(parent.deleted).toBe(true);
    expect(parent.name).toBeNull();
    expect(parentDeletedLabel(parent)).toBe("حساب والد حذف شده است");
  });

  test("missing child profile is safe", () => {
    expect(mapChildProfileLabel(null)).toBe("بدون پروفایل کودک");
    expect(mapChildProfileLabel(undefined)).toBe("بدون پروفایل کودک");
    expect(mapChildProfileLabel("")).toBe("بدون پروفایل کودک");
  });

  test("parent info only includes safe display name and email", () => {
    const parent = mapParentInfo("مریم احمدی", "m@example.com", false);
    expect(parent.name).toBe("مریم احمدی");
    expect(parent.email).toBe("m@example.com");
    expect(parent.deleted).toBe(false);
    expect(Object.keys(parent).sort()).toEqual(["deleted", "email", "name"]);
  });
});

describe("image detail mapping", () => {
  test("maps image type rows", () => {
    const rows = mapImageTypeRows({
      description: "صحنه: تولد\nسبک: شاد",
      characterName: "کاپیتان آبنبات",
      referenceFile: true,
      consentGranted: true,
    });
    expect(rows).toContainEqual({ label: "شخصیت", value: "کاپیتان آبنبات" });
    expect(rows).toContainEqual({ label: "فایل مرجع", value: "بارگذاری شده" });
    expect(rows).toContainEqual({ label: "رضایت والد", value: "ثبت شده" });
  });

  test("image absent values show ثبت نشده", () => {
    const rows = mapImageTypeRows({
      description: null,
      characterName: null,
      referenceFile: false,
      consentGranted: false,
    });
    expect(rows).toContainEqual({ label: "شخصیت", value: "ثبت نشده" });
    expect(rows).toContainEqual({ label: "فایل مرجع", value: "بارگذاری نشده" });
    expect(rows).toContainEqual({ label: "رضایت والد", value: "ثبت نشده" });
  });
});

describe("video detail mapping", () => {
  test("maps video type rows", () => {
    const rows = mapVideoTypeRows({
      description: "یادداشت والد",
      characterName: "پرنسس لوما",
      script: "داستان شب",
      style: "کارتونی",
      referenceFile: true,
      consentGranted: true,
    });
    expect(rows).toContainEqual({ label: "سناریو", value: "داستان شب", multiline: true });
    expect(rows).toContainEqual({ label: "سبک ویدیو", value: "کارتونی" });
    expect(rows).toContainEqual({ label: "فایل مرجع", value: "بارگذاری شده" });
  });

  test("video absent values show ثبت نشده", () => {
    const rows = mapVideoTypeRows({
      description: null,
      characterName: null,
      script: null,
      style: null,
      referenceFile: false,
      consentGranted: false,
    });
    expect(rows).toContainEqual({ label: "سناریو", value: "ثبت نشده", multiline: true });
    expect(rows).toContainEqual({ label: "سبک ویدیو", value: "ثبت نشده" });
  });
});

describe("drawing-animation detail mapping", () => {
  test("maps drawing type rows", () => {
    const rows = mapDrawingTypeRows({
      description: "توضیح متحرک‌سازی",
      animationStyle: "نرم",
      sourceDrawing: true,
      consentGranted: true,
    });
    expect(rows).toContainEqual({ label: "سبک انیمیشن", value: "نرم" });
    expect(rows).toContainEqual({ label: "نقاشی منبع", value: "بارگذاری شده" });
  });

  test("drawing absent values show ثبت نشده", () => {
    const rows = mapDrawingTypeRows({
      description: null,
      animationStyle: null,
      sourceDrawing: false,
      consentGranted: false,
    });
    expect(rows).toContainEqual({ label: "سبک انیمیشن", value: "ثبت نشده" });
    expect(rows).toContainEqual({ label: "نقاشی منبع", value: "بارگذاری نشده" });
  });
});

describe("media metadata and privacy", () => {
  const asset = {
    id: "asset-1",
    type: "upload",
    mime_type: "image/png",
    file_url: "user-123/order-456/photo.png",
    created_at: "2026-07-31T10:00:00Z",
  };

  test("public model excludes the private storage path", () => {
    const media = mapMediaAsset(asset, "https://signed.example/x");
    expect(media.fileName).toBe("photo.png");
    expect("file_url" in media).toBe(false);
    expect(JSON.stringify(media)).not.toContain("user-123/order-456/photo.png");
  });

  test("signed URL failure is represented safely", () => {
    const media = mapMediaAsset(asset, null);
    expect(media.signedUrl).toBeNull();
    expect(media.signedUrlFailed).toBe(true);
    expect(media.fileName).toBe("photo.png");
  });

  test("generated asset maps without a signed URL", () => {
    const media = mapMediaAsset({ ...asset, type: "generated" }, null);
    expect(media.kind).toBe("generated");
  });
});

describe("filter validation", () => {
  test("invalid type filter rejected safely (falls back to null)", () => {
    expect(parseTypeFilter("hologram")).toBeNull();
    expect(parseTypeFilter(["image"])).toBe("image");
    expect(parseTypeFilter(undefined)).toBeNull();
    expect(parseTypeFilter("")).toBeNull();
  });

  test("invalid status filter rejected safely", () => {
    expect(parseStatusFilter("weird_state")).toBeNull();
    expect(parseStatusFilter("pending_review")).toBe("pending_review");
    expect(parseStatusFilter(["ready"])).toBe("ready");
  });

  test("page number parsing", () => {
    expect(parsePageNumber("3")).toBe(3);
    expect(parsePageNumber("0")).toBe(1);
    expect(parsePageNumber("-2")).toBe(1);
    expect(parsePageNumber("abc")).toBe(1);
    expect(parsePageNumber(undefined)).toBe(1);
  });

  test("page size parsing respects max and default", () => {
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("10")).toBe(10);
    expect(parsePageSize("999")).toBe(MAX_PAGE_SIZE);
    expect(parsePageSize("0")).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("pagination boundaries", () => {
  test("clamps page to totalPages", () => {
    expect(clampPage(1, 4)).toBe(1);
    expect(clampPage(5, 4)).toBe(4);
    expect(clampPage(0, 4)).toBe(1);
    expect(clampPage(2, 0)).toBe(1);
  });
});

describe("queue row and detail mapping", () => {
  test("maps queue row with parent deleted fallback", () => {
    const row = mapQueueRow({
      id: "o-1",
      type: "video",
      status: "pending_review",
      title: "داستان شب",
      candy_cost: 45,
      created_at: "2026-07-31T10:00:00Z",
      updated_at: "2026-07-31T10:00:00Z",
      parentFullName: null,
      parentProfileMissing: true,
      childProfileId: null,
    });
    expect(row.typeLabel).toBe("ویدیو");
    expect(row.parentDeleted).toBe(true);
    expect(row.parentName).toBeNull();
    expect(row.childLabel).toBe("بدون پروفایل کودک");
    expect(row.statusLabel).toBe("در انتظار بررسی");
  });

  test("maps order detail without leaking internal fields", () => {
    const detail = mapOrderDetail({
      id: "o-1",
      type: "image",
      status: "ready",
      title: "تصویر تولد",
      description: "توضیح",
      candy_cost: 15,
      moderation_status: "passed",
      created_at: "2026-07-31T10:00:00Z",
      updated_at: "2026-07-31T10:00:00Z",
      parentFullName: "مریم",
      parentEmail: "m@example.com",
      parentProfileMissing: false,
      childProfileId: null,
      characterName: "کاپیتان آبنبات",
      consentGranted: true,
      typeRows: [{ label: "شخصیت", value: "کاپیتان آبنبات" }],
      media: [],
    });
    expect(detail.typeLabel).toBe("تصویر");
    expect(detail.statusLabel).toBe("آماده تحویل");
    expect(detail.moderationStatusLabel).toBe("تأیید شده");
    expect(detail.parent.name).toBe("مریم");
    expect(JSON.stringify(detail)).not.toContain("file_url");
    expect(JSON.stringify(detail)).not.toContain("parent_profiles");
  });

  test("unknown order type and status map safely in detail", () => {
    const detail = mapOrderDetail({
      id: "o-2",
      type: "hologram",
      status: "weird",
      title: "؟",
      description: null,
      candy_cost: 0,
      moderation_status: "unknown",
      created_at: "2026-07-31T10:00:00Z",
      updated_at: "2026-07-31T10:00:00Z",
      parentFullName: null,
      parentEmail: null,
      parentProfileMissing: true,
      childProfileId: null,
      characterName: null,
      consentGranted: false,
      typeRows: [],
      media: [],
    });
    expect(detail.type).toBeNull();
    expect(detail.status).toBeNull();
    expect(detail.typeLabel).toBe(UNKNOWN_REQUEST_TYPE_LABEL);
    expect(detail.statusLabel).toBe("وضعیت نامشخص");
    expect(detail.moderationStatusLabel).toBe("نامشخص");
  });
});

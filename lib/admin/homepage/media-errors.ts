import type { AdminHomepageApiErrorCode } from "@/lib/admin/homepage/types";

export type AdminHomepageMediaErrorCode =
  | AdminHomepageApiErrorCode
  | "HOMEPAGE_MEDIA_BAD_SLOT"
  | "HOMEPAGE_MEDIA_BAD_FILE"
  | "HOMEPAGE_MEDIA_TOO_LARGE"
  | "HOMEPAGE_MEDIA_GEOMETRY_REQUIRED"
  | "HOMEPAGE_LAYOUT_CONFLICT"
  | "HOMEPAGE_LAYOUT_INVALID";

/**
 * Maps trusted media/layout RPC exception codes to safe admin-facing HTTP
 * errors with Persian messages. Unknown codes collapse to a generic 500 —
 * raw database strings are never exposed.
 */
export function mapAdminHomepageMediaRpcError(message: unknown): {
  code: AdminHomepageMediaErrorCode;
  message: string;
  status: number;
} {
  const code = typeof message === "string" ? message : "unknown_error";
  switch (code) {
    case "homepage_media_forbidden":
    case "homepage_layout_forbidden":
      return { code: "HOMEPAGE_FORBIDDEN", status: 403, message: "شما مجوز انجام این عملیات را ندارید." };
    case "homepage_media_invalid_slot":
      return { code: "HOMEPAGE_MEDIA_BAD_SLOT", status: 400, message: "جایگاه رسانه نامعتبر است." };
    case "homepage_media_type_mismatch":
    case "homepage_media_invalid_mime":
    case "homepage_media_invalid_path":
    case "homepage_media_invalid_size":
    case "homepage_media_invalid":
      return { code: "HOMEPAGE_MEDIA_BAD_FILE", status: 422, message: "فایل ارسال‌شده برای این جایگاه معتبر نیست." };
    case "homepage_media_geometry_required":
      return {
        code: "HOMEPAGE_MEDIA_GEOMETRY_REQUIRED",
        status: 422,
        message: "برای فعال‌سازی پس‌زمینه جدید هیرو، ابتدا موقعیت ویدیوی تلویزیون را روی تصویر تنظیم و تأیید کنید.",
      };
    case "homepage_media_layout_conflict":
    case "homepage_layout_conflict":
      return {
        code: "HOMEPAGE_LAYOUT_CONFLICT",
        status: 409,
        message: "چیدمان توسط مدیر دیگری تغییر کرده است. نسخه جدید را بارگذاری کنید.",
      };
    case "homepage_media_layout_invalid":
    case "homepage_layout_invalid":
      return { code: "HOMEPAGE_LAYOUT_INVALID", status: 422, message: "مختصات موقعیت تلویزیون معتبر نیست." };
    case "homepage_media_layout_missing":
    case "homepage_layout_not_found":
    case "homepage_media_not_found":
      return { code: "HOMEPAGE_NOT_FOUND", status: 404, message: "رکورد رسانه مورد نظر یافت نشد." };
    default:
      return { code: "HOMEPAGE_UNKNOWN_ERROR", status: 500, message: "عملیات رسانه انجام نشد." };
  }
}

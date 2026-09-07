import type { AdminHomepageApiErrorCode } from "@/lib/admin/homepage/types";

export interface AdminHomepageRpcError {
  code: AdminHomepageApiErrorCode;
  message: string;
  status: number;
}

/**
 * Maps the trusted-RPC raised exception (message = short code, see
 * 20260802110000_homepage_cms_admin_write.sql) to a safe admin-facing HTTP
 * error with a Persian message. Unknown codes fall back to a generic 500 —
 * raw database strings are never exposed.
 */
export function mapAdminHomepageRpcError(message: unknown): AdminHomepageRpcError {
  const code = typeof message === "string" ? message : "unknown_error";

  switch (code) {
    case "homepage_admin_forbidden":
      return { code: "HOMEPAGE_FORBIDDEN", status: 403, message: "شما مجوز انجام این عملیات را ندارید." };

    case "homepage_admin_not_found":
      return { code: "HOMEPAGE_NOT_FOUND", status: 404, message: "محتوای صفحه اصلی یافت نشد." };

    case "homepage_admin_conflict":
      return {
        code: "HOMEPAGE_CONFLICT",
        status: 409,
        message: "این صفحه توسط مدیر دیگری تغییر کرده است. نسخه جدید را بارگذاری کنید و تغییرات خود را دوباره اعمال کنید.",
      };

    case "homepage_admin_invalid":
      return { code: "HOMEPAGE_INVALID", status: 422, message: "محتوای ارسال‌شده معتبر نیست." };

    default:
      return { code: "HOMEPAGE_UNKNOWN_ERROR", status: 500, message: "ذخیره تغییرات انجام نشد." };
  }
}

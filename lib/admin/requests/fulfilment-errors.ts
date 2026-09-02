import type { FulfilmentApiErrorCode } from "@/lib/admin/requests/fulfilment-error-codes";

export interface FulfilmentRpcError {
  code: FulfilmentApiErrorCode;
  message: string;
  status: number;
}

/**
 * Maps a fulfilment trusted-RPC raised exception (message = error code) to a
 * safe Admin-facing HTTP error with a Persian message. Unknown codes fall back
 * to a generic 500 — raw database strings are never exposed to the client.
 *
 * Code → HTTP mapping:
 *   not found / asset not found            → 404
 *   status conflict / unchanged / upload   → 409
 *   admin forbidden / unauthorized         → 403
 *   everything else (validation, rules)    → 422
 */
export function mapFulfilmentRpcError(message: unknown): FulfilmentRpcError {
  const code = typeof message === "string" ? message : "unknown_error";

  switch (code) {
    case "request_admin_forbidden":
    case "request_forbidden":
      return { code: "REQUEST_UNAUTHORIZED", status: 403, message: "شما مجوز انجام این عملیات را ندارید." };

    case "request_not_found":
      return { code: "REQUEST_NOT_FOUND", status: 404, message: "درخواست مورد نظر یافت نشد." };

    case "request_status_conflict":
      return {
        code: "REQUEST_STATUS_CONFLICT",
        status: 409,
        message: "این درخواست توسط مدیر دیگری تغییر کرده است. اطلاعات جدید را دوباره بارگذاری کنید.",
      };

    case "request_status_unchanged":
      return {
        code: "REQUEST_STATUS_UNCHANGED",
        status: 409,
        message: "وضعیت درخواست قبلاً همین مقدار است.",
      };

    case "request_transition_invalid":
      return {
        code: "REQUEST_TRANSITION_INVALID",
        status: 422,
        message: "تغییر وضعیت درخواست در این مرحله امکان‌پذیر نیست.",
      };

    case "request_invalid_status":
      return { code: "REQUEST_INVALID_STATUS", status: 422, message: "وضعیت ارسال‌شده معتبر نیست." };

    case "request_final_media_required":
      return {
        code: "REQUEST_FINAL_MEDIA_REQUIRED",
        status: 422,
        message: "قبل از آماده‌سازی تحویل، حداقل یک فایل خروجی تأییدشده بارگذاری کنید.",
      };

    case "request_rejection_reason_required":
      return {
        code: "REQUEST_REJECTION_REASON_REQUIRED",
        status: 422,
        message: "برای رد درخواست، دلیل را وارد کنید.",
      };

    case "request_note_too_long":
      return {
        code: "REQUEST_NOTE_TOO_LONG",
        status: 422,
        message: "متن یادداشت نباید بیشتر از ۲۰۰۰ نویسه باشد.",
      };

    case "request_upload_not_allowed":
      return {
        code: "REQUEST_UPLOAD_NOT_ALLOWED",
        status: 409,
        message: "بارگذاری فایل خروجی در وضعیت فعلی درخواست امکان‌پذیر نیست.",
      };

    case "request_invalid_path":
      return {
        code: "REQUEST_FILE_INVALID",
        status: 400,
        message: "مسیر فایل خروجی نامعتبر است.",
      };

    case "request_file_invalid":
      return { code: "REQUEST_FILE_INVALID", status: 422, message: "فایل ارسال‌شده معتبر نیست." };

    case "request_file_not_found":
      return {
        code: "REQUEST_FILE_INVALID",
        status: 500,
        message: "فایل خروجی در سامانه یافت نشد. بارگذاری دوباره انجام شود.",
      };

    case "request_asset_not_found":
      return { code: "REQUEST_ASSET_NOT_FOUND", status: 404, message: "فایل مورد نظر یافت نشد." };

    case "request_asset_not_final":
      return {
        code: "REQUEST_ASSET_NOT_FINAL",
        status: 422,
        message: "فقط فایل‌های خروجی نهایی قابل تأیید هستند.",
      };

    case "request_asset_not_uploaded":
      return {
        code: "REQUEST_ASSET_NOT_UPLOADED",
        status: 409,
        message: "این فایل قبلاً تأیید یا جایگزین شده است.",
      };

    case "request_asset_already_superseded":
      return {
        code: "REQUEST_ASSET_ALREADY_SUPERSEDED",
        status: 409,
        message: "این فایل قبلاً با نسخه جدید جایگزین شده است.",
      };

    default:
      return { code: "REQUEST_UNKNOWN_ERROR", status: 500, message: "خطای داخلی سرور رخ داد." };
  }
}

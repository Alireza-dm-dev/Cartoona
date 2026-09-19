export interface RequestRpcError {
  status: number
  code: string
  error: string
  headers?: Record<string, string>
}

/**
 * Parent-facing Persian text for every failure the request RPC can raise.
 *
 * The RPC's own HINT is written for whoever is reading the database logs: it
 * is English, and it describes internal rules ("Duration choice does not match
 * the pricing tier", "File path must start with the authenticated user ID").
 * Echoing it to the browser both broke the Persian-first rule and narrated the
 * server's internals to anyone poking at the endpoint, so the hint is no
 * longer forwarded. A code with no entry here falls back to the generic
 * message rather than leaking whatever the database happened to say.
 */
const MESSAGES: Record<string, string> = {
  request_unauthenticated: "لطفاً دوباره وارد حساب خود شوید.",
  request_parent_required: "فقط حساب‌های والد می‌توانند درخواست ثبت کنند.",
  request_parent_profile_missing: "پروفایل والد یافت نشد. لطفاً دوباره وارد شوید.",
  request_consent_required: "برای ثبت درخواست، ابتدا رضایت والدین را ثبت کنید.",

  INSUFFICIENT_CANDIES: "موجودی آب‌نبات شما برای این درخواست کافی نیست.",
  CANDY_WALLET_NOT_FOUND: "کیف پول آب‌نبات شما در دسترس نیست. لطفاً با پشتیبانی تماس بگیرید.",
  CREATION_PRICING_UNAVAILABLE: "قیمت این درخواست در حال حاضر در دسترس نیست.",

  // Shape problems. These mean the draft and the form disagree, which a parent
  // fixes by going back a step — so each one says what to do, not what rule of
  // the schema was broken.
  request_invalid_type: "نوع این درخواست پشتیبانی نمی‌شود.",
  request_character_required: "لطفاً یک شخصیت انتخاب کنید.",
  request_character_not_found: "شخصیت انتخاب‌شده در دسترس نیست. لطفاً شخصیت دیگری انتخاب کنید.",
  request_character_not_allowed: "برای این نوع درخواست نمی‌توان شخصیت انتخاب کرد.",
  request_invalid_duration: "مدت زمان انتخاب‌شده معتبر نیست.",
  request_invalid_duration_choice: "مدت زمان انتخاب‌شده معتبر نیست. لطفاً دوباره انتخاب کنید.",
  request_duration_not_allowed: "برای این نوع درخواست نمی‌توان مدت زمان انتخاب کرد.",
  request_duration_choice_not_allowed: "برای این نوع درخواست نمی‌توان مدت زمان انتخاب کرد.",
  request_characters_speak_required: "لطفاً مشخص کنید کاراکترها صحبت کنند یا خیر.",
  request_characters_speak_not_allowed: "این گزینه فقط برای درخواست ویدیو قابل انتخاب است.",
  request_video_script_required: "لطفاً توضیح داستان را وارد کنید.",
  request_video_script_not_allowed: "برای این نوع درخواست نمی‌توان سناریو ثبت کرد.",
  request_video_style_not_allowed: "برای این نوع درخواست نمی‌توان سبک ویدیو ثبت کرد.",
  request_animation_style_required: "لطفاً نوع حرکت را انتخاب کنید.",
  request_animation_style_too_long: "نوع حرکت بیش از حد طولانی است.",
  request_animation_style_not_allowed: "برای این نوع درخواست نمی‌توان نوع حرکت ثبت کرد.",
  request_title_too_long: "عنوان درخواست بیش از حد طولانی است.",
  request_description_too_long: "توضیحات درخواست بیش از حد طولانی است.",
  request_child_name_too_long: "نام کودک نباید بیشتر از ۶۰ کاراکتر باشد.",

  // File problems. The parent can only act on one of these — reselecting the
  // file — so they all say that, whatever the internal cause was.
  request_file_required: "برای این درخواست انتخاب فایل الزامی است.",
  request_file_not_found: "فایل انتخاب‌شده در دسترس نیست. لطفاً دوباره انتخاب کنید.",
  request_file_type_invalid: "فرمت فایل پشتیبانی نمی‌شود. فقط JPEG، PNG و WebP مجاز هستند.",
  request_invalid_file_path: "فایل انتخاب‌شده در دسترس نیست. لطفاً دوباره انتخاب کنید.",
}

const GENERIC_MESSAGE = "ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید."

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const

/**
 * Map a raised RPC error onto an HTTP status and a safe Persian message.
 *
 * The database HINT is deliberately not a parameter: there is nothing this
 * function could safely do with it, and accepting one invites a future caller
 * to forward it. See the note on MESSAGES above.
 */
export function mapRequestRpcError(message: unknown): RequestRpcError {
  const raised = typeof message === "string" && message.length > 0 ? message : "unknown_error"

  // Only codes this module knows are echoed back. Postgres raises plenty of
  // errors that are not ours — 'invalid input syntax for type uuid: "Robo
  // Bobo"' names a column type and a value — and passing the raised string
  // through as `code` republished exactly the internals the message field is
  // careful to withhold.
  const known = Object.prototype.hasOwnProperty.call(MESSAGES, raised)
  const code = known || raised === "unknown_error" ? raised : "request_failed"

  let status = 422
  if (code === "request_unauthenticated") status = 401
  else if (
    code === "request_parent_required" ||
    code === "request_consent_required" ||
    code === "request_parent_profile_missing"
  ) status = 403
  else if (code === "INSUFFICIENT_CANDIES") status = 402
  else if (code === "CANDY_WALLET_NOT_FOUND") status = 409
  else if (code === "CREATION_PRICING_UNAVAILABLE") status = 503

  const error = known ? MESSAGES[raised] : GENERIC_MESSAGE

  // Pricing and balance answers must never be cached: both change underneath
  // the parent, and a cached "not available" would outlive the outage.
  if (
    code === "CREATION_PRICING_UNAVAILABLE" ||
    code === "INSUFFICIENT_CANDIES" ||
    code === "CANDY_WALLET_NOT_FOUND"
  ) {
    return { status, code, error, headers: { ...NO_STORE_HEADERS } }
  }

  return { status, code, error }
}

/**
 * Canonical Iranian mobile normalization and credential validation.
 *
 * This is the single source of truth shared by signup, OTP issue, OTP verify,
 * password login and parent lookup. It deliberately contains no Node-only
 * imports so Client Components can use the exact same rules the server
 * enforces — previously each page carried its own copy, which is how an
 * issue/verify format drift becomes possible.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
const ENGLISH_DIGITS = "0123456789"

/** Minimum parent password length. Supabase enforces its own floor of 6. */
export const PARENT_PASSWORD_MIN_LENGTH = 8
/** bcrypt only hashes the first 72 bytes; reject longer rather than truncate. */
export const PARENT_PASSWORD_MAX_LENGTH = 72

export function toEnglishDigits(raw: string): string {
  let result = ""
  for (const ch of raw) {
    const pi = PERSIAN_DIGITS.indexOf(ch)
    if (pi !== -1) { result += ENGLISH_DIGITS[pi]; continue }
    const ai = ARABIC_DIGITS.indexOf(ch)
    if (ai !== -1) { result += ENGLISH_DIGITS[ai]; continue }
    result += ch
  }
  return result
}

export function toPersianDigits(raw: string): string {
  return raw.replace(/\d/g, (ch) => PERSIAN_DIGITS[ENGLISH_DIGITS.indexOf(ch)] || ch)
}

/**
 * Canonical form is always `+989XXXXXXXXX`.
 *
 * Accepts `09…`, `9…`, `989…`, `+989…` and `00989…`, in English, Persian or
 * Arabic-Indic digits, with spaces, dashes or parentheses. Malformed input is
 * returned in canonical shape too, so callers must always pair this with
 * `isValidIranPhone` rather than trusting the string.
 */
export function normalizeIranPhone(raw: string): string {
  const cleaned = toEnglishDigits(raw).replace(/[\s\-()]/g, "")
  const digits = cleaned.replace(/\D/g, "")
  let national: string
  if (digits.startsWith("0098")) {
    national = digits.slice(4)
  } else if (digits.startsWith("98") && digits.length >= 11) {
    national = digits.slice(2)
  } else if (digits.startsWith("0")) {
    national = digits.slice(1)
  } else {
    national = digits
  }
  return "+98" + national
}

export function isValidIranPhone(normalized: string): boolean {
  return /^\+989\d{9}$/.test(normalized)
}

/** Normalize and validate in one step. Returns null for malformed input. */
export function toCanonicalIranPhone(raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const normalized = normalizeIranPhone(raw)
  return isValidIranPhone(normalized) ? normalized : null
}

export function isValidParentPassword(password: string): boolean {
  if (typeof password !== "string") return false
  if (password.length < PARENT_PASSWORD_MIN_LENGTH) return false
  // TextEncoder rather than Buffer: this module runs in the browser too.
  if (new TextEncoder().encode(password).length > PARENT_PASSWORD_MAX_LENGTH) return false
  return true
}

export function isValidFullName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 2 && trimmed.length <= 100
}

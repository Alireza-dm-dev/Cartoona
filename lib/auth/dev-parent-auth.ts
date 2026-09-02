import crypto from "node:crypto"

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
const ENGLISH_DIGITS = "0123456789"

function toEnglishDigits(raw: string): string {
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

export function deriveDevEmail(normalizedPhone: string): string {
  const local = normalizedPhone.replace(/^\+/, "")
  return `parent-${local}@dev.cartoona.example`
}

export function isValidFullName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 2 && trimmed.length <= 100
}

export function isDevAuthEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false
  if (process.env.DEV_PARENT_AUTH_ENABLED !== "true") return false
  const secret = process.env.DEV_PARENT_AUTH_SECRET
  if (!secret || secret.length < 32) return false
  return true
}

export function isLocalhost(host: string): boolean {
  const h = host.split(":")[0]
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]"
}

function getDevSecret(): string {
  return process.env.DEV_PARENT_AUTH_SECRET!
}

export function generateOtpChallenge(
  purpose: "signup" | "login",
  phone: string,
  fullName?: string,
): { challengeToken: string; developmentCode: string; expiresInSeconds: number } {
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0")
  const now = Math.floor(Date.now() / 1000)
  const expiresInSeconds = 300

  const payload: Record<string, unknown> = {
    purpose,
    phone,
    code,
    iat: now,
    exp: now + expiresInSeconds,
    nonce: crypto.randomBytes(16).toString("hex"),
  }

  if (purpose === "signup" && fullName) {
    payload.fullName = fullName
  }

  const serialized = JSON.stringify(payload)
  const signature = crypto
    .createHmac("sha256", getDevSecret())
    .update(serialized)
    .digest("hex")

  const challengeToken = Buffer.from(
    JSON.stringify({ signed: serialized, signature }),
  ).toString("base64url")

  return { challengeToken, developmentCode: code, expiresInSeconds }
}

export function verifyOtpChallenge(
  challengeToken: string,
  purpose: "signup" | "login",
  phone: string,
  code: string,
  expectedFullName?: string,
): boolean {
  let parsed: { signed: string; signature: string }
  try {
    parsed = JSON.parse(
      Buffer.from(challengeToken, "base64url").toString("utf-8"),
    )
  } catch {
    return false
  }

  const { signed, signature } = parsed
  if (!signed || !signature) return false

  const expectedSig = crypto
    .createHmac("sha256", getDevSecret())
    .update(signed)
    .digest("hex")

  if (signature.length !== expectedSig.length) return false
  let diff = 0
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i)
  }
  if (diff !== 0) return false

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(signed)
  } catch {
    return false
  }

  if (payload.purpose !== purpose) return false
  if (payload.phone !== phone) return false
  if (payload.code !== code) return false

  if (purpose === "signup" && expectedFullName !== undefined) {
    if (payload.fullName !== expectedFullName) return false
  }

  const now = Math.floor(Date.now() / 1000)
  if (now > (payload.exp as number)) return false

  return true
}

export function generateRandomPassword(): string {
  return crypto.randomBytes(24).toString("base64url")
}

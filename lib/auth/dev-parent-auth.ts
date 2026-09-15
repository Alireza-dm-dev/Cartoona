import crypto from "node:crypto"

// Re-exported so server-side callers keep a single import site while the rules
// themselves live in the shared, client-safe module.
export {
  normalizeIranPhone,
  isValidIranPhone,
  isValidFullName,
  isValidParentPassword,
  toCanonicalIranPhone,
  PARENT_PASSWORD_MIN_LENGTH,
  PARENT_PASSWORD_MAX_LENGTH,
} from "./phone"

export function deriveDevEmail(normalizedPhone: string): string {
  const local = normalizedPhone.replace(/^\+/, "")
  return `parent-${local}@dev.cartoona.example`
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

export type OtpFailureReason =
  | "malformed"
  | "bad_signature"
  | "mismatch"
  | "wrong_code"
  | "expired"
  | "already_used"
  | "too_many_attempts"

export type OtpVerifyResult = { ok: true } | { ok: false; reason: OtpFailureReason }

/** Wrong guesses tolerated per challenge before it is burned. */
export const MAX_OTP_ATTEMPTS = 5

interface ChallengeState {
  attempts: number
  consumed: boolean
  /** Unix seconds; used only to evict stale entries. */
  exp: number
}

// In-memory, per-process state for an otherwise stateless HMAC challenge.
// It exists to enforce two properties the token alone cannot: a code may not be
// replayed after it has been successfully used, and a code may not be brute
// forced across its 5-minute lifetime. The dev route is localhost-only and
// single-process, so a Map is sufficient; a production SMS path would need a
// shared store instead.
const challengeStates = new Map<string, ChallengeState>()

function challengeKey(challengeToken: string): string {
  return crypto.createHash("sha256").update(challengeToken).digest("hex")
}

function evictExpired(now: number): void {
  for (const [key, state] of challengeStates) {
    if (state.exp <= now) challengeStates.delete(key)
  }
}

function decodeChallenge(
  challengeToken: string,
  purpose: "signup" | "login",
  phone: string,
  code: string,
  expectedFullName?: string,
): OtpVerifyResult {
  let parsed: { signed: string; signature: string }
  try {
    parsed = JSON.parse(
      Buffer.from(challengeToken, "base64url").toString("utf-8"),
    )
  } catch {
    return { ok: false, reason: "malformed" }
  }

  const { signed, signature } = parsed
  if (!signed || !signature) return { ok: false, reason: "malformed" }

  const expectedSig = crypto
    .createHmac("sha256", getDevSecret())
    .update(signed)
    .digest("hex")

  if (signature.length !== expectedSig.length) return { ok: false, reason: "bad_signature" }
  if (
    !crypto.timingSafeEqual(Buffer.from(signature, "utf-8"), Buffer.from(expectedSig, "utf-8"))
  ) {
    return { ok: false, reason: "bad_signature" }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(signed)
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (payload.purpose !== purpose) return { ok: false, reason: "mismatch" }
  if (payload.phone !== phone) return { ok: false, reason: "mismatch" }

  if (purpose === "signup" && expectedFullName !== undefined) {
    if (payload.fullName !== expectedFullName) return { ok: false, reason: "mismatch" }
  }

  // Expiry is checked before the code so a stale-but-correct code reports
  // honestly as expired rather than as a wrong code.
  const now = Math.floor(Date.now() / 1000)
  if (now > (payload.exp as number)) return { ok: false, reason: "expired" }

  if (typeof payload.code !== "string" || typeof code !== "string") {
    return { ok: false, reason: "wrong_code" }
  }
  if (payload.code.length !== code.length) return { ok: false, reason: "wrong_code" }
  if (!crypto.timingSafeEqual(Buffer.from(payload.code, "utf-8"), Buffer.from(code, "utf-8"))) {
    return { ok: false, reason: "wrong_code" }
  }

  return { ok: true }
}

/**
 * Pure signature/expiry/code check with no state effects.
 *
 * Kept for tests and for callers that only need the predicate. Request handlers
 * must use `consumeOtpChallenge` so replay and brute force are actually blocked.
 */
export function verifyOtpChallenge(
  challengeToken: string,
  purpose: "signup" | "login",
  phone: string,
  code: string,
  expectedFullName?: string,
): boolean {
  return decodeChallenge(challengeToken, purpose, phone, code, expectedFullName).ok
}

/**
 * Verify a challenge and, on success, burn it so the same code cannot be used
 * twice. The challenge is only consumed on success — a wrong guess costs an
 * attempt but leaves the displayed code valid for its documented lifetime.
 */
export function consumeOtpChallenge(
  challengeToken: string,
  purpose: "signup" | "login",
  phone: string,
  code: string,
  expectedFullName?: string,
): OtpVerifyResult {
  const now = Math.floor(Date.now() / 1000)
  evictExpired(now)

  const key = challengeKey(challengeToken)
  const state = challengeStates.get(key)

  if (state?.consumed) return { ok: false, reason: "already_used" }
  if (state && state.attempts >= MAX_OTP_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" }
  }

  const result = decodeChallenge(challengeToken, purpose, phone, code, expectedFullName)

  if (!result.ok) {
    // Only track challenges that are genuinely ours; garbage tokens must not
    // let a caller grow the map.
    if (result.reason !== "malformed" && result.reason !== "bad_signature") {
      const next = state ?? { attempts: 0, consumed: false, exp: now + 300 }
      next.attempts += 1
      challengeStates.set(key, next)
    }
    return result
  }

  challengeStates.set(key, {
    attempts: state?.attempts ?? 0,
    consumed: true,
    exp: now + 300,
  })
  return { ok: true }
}

/** Test-only reset so state cannot leak between cases. */
export function resetOtpChallengeStateForTests(): void {
  challengeStates.clear()
}

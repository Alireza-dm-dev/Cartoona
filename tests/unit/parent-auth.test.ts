import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// The OTP module reads the secret at call time, so setting it before import is
// enough and no test ever needs the real one.
process.env.DEV_PARENT_AUTH_SECRET = "a".repeat(64)

import {
  normalizeIranPhone,
  isValidIranPhone,
  toCanonicalIranPhone,
  isValidParentPassword,
  isValidFullName,
  toPersianDigits,
  PARENT_PASSWORD_MIN_LENGTH,
  PARENT_PASSWORD_MAX_LENGTH,
} from "@/lib/auth/phone"

import {
  generateOtpChallenge,
  verifyOtpChallenge,
  consumeOtpChallenge,
  resetOtpChallengeStateForTests,
  isDevAuthEnabled,
  isLocalhost,
  deriveDevEmail,
  MAX_OTP_ATTEMPTS,
} from "@/lib/auth/dev-parent-auth"

const PHONE = "+989123456789"

beforeEach(() => {
  resetOtpChallengeStateForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Iranian phone normalization", () => {
  it("maps every supported form to one canonical value", () => {
    const forms = [
      "09123456789",
      "+989123456789",
      "989123456789",
      "9123456789",
      "00989123456789",
      "0912 345 6789",
      "0912-345-6789",
      "(0912) 345 6789",
      "۰۹۱۲۳۴۵۶۷۸۹",
      "٠٩١٢٣٤٥٦٧٨٩",
    ]
    for (const form of forms) {
      expect(normalizeIranPhone(form), form).toBe(PHONE)
      expect(toCanonicalIranPhone(form), form).toBe(PHONE)
    }
  })

  it("is idempotent", () => {
    expect(normalizeIranPhone(normalizeIranPhone("09123456789"))).toBe(PHONE)
  })

  it("rejects malformed and too-short numbers", () => {
    const invalid = [
      "",
      "   ",
      "093525",
      "0935250000",
      "091234567890",
      "08123456789",
      "+981234567890",
      "abcdefghijk",
      "+1 415 555 0123",
    ]
    for (const value of invalid) {
      expect(isValidIranPhone(normalizeIranPhone(value)), value).toBe(false)
      expect(toCanonicalIranPhone(value), value).toBeNull()
    }
  })

  it("rejects the short value from the signup screenshot", () => {
    expect(toCanonicalIranPhone("093525")).toBeNull()
  })

  it("only accepts mobile prefixes (+989…)", () => {
    expect(isValidIranPhone("+982123456789")).toBe(false)
    expect(isValidIranPhone(PHONE)).toBe(true)
  })

  it("derives a stable dev email from the canonical phone", () => {
    expect(deriveDevEmail(PHONE)).toBe("parent-989123456789@dev.cartoona.example")
    expect(deriveDevEmail(normalizeIranPhone("09123456789"))).toBe(
      deriveDevEmail(normalizeIranPhone("+989123456789")),
    )
  })

  it("renders digits in Persian for display", () => {
    expect(toPersianDigits("012345")).toBe("۰۱۲۳۴۵")
  })
})

describe("credential validation", () => {
  it("enforces the minimum password length", () => {
    expect(isValidParentPassword("a".repeat(PARENT_PASSWORD_MIN_LENGTH - 1))).toBe(false)
    expect(isValidParentPassword("a".repeat(PARENT_PASSWORD_MIN_LENGTH))).toBe(true)
  })

  it("rejects passwords longer than bcrypt can hash", () => {
    expect(isValidParentPassword("a".repeat(PARENT_PASSWORD_MAX_LENGTH))).toBe(true)
    expect(isValidParentPassword("a".repeat(PARENT_PASSWORD_MAX_LENGTH + 1))).toBe(false)
  })

  it("counts multi-byte characters by byte length", () => {
    // Persian characters are 2 bytes each, so 40 of them exceed the 72-byte cap.
    expect(isValidParentPassword("م".repeat(40))).toBe(false)
    expect(isValidParentPassword("م".repeat(10))).toBe(true)
  })

  it("validates parent names", () => {
    expect(isValidFullName("م")).toBe(false)
    expect(isValidFullName("مریم احمدی")).toBe(true)
    expect(isValidFullName("a".repeat(101))).toBe(false)
  })
})

describe("dev OTP issue/verify consistency", () => {
  it("verifies the exact code it issued", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    expect(challenge.developmentCode).toMatch(/^\d{6}$/)
    expect(challenge.expiresInSeconds).toBe(300)
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: true })
  })

  it("verifies a signup code including the bound parent name", () => {
    const challenge = generateOtpChallenge("signup", PHONE, "مریم احمدی")
    expect(
      consumeOtpChallenge(
        challenge.challengeToken,
        "signup",
        PHONE,
        challenge.developmentCode,
        "مریم احمدی",
      ),
    ).toEqual({ ok: true })
  })

  it("verifies regardless of which supported phone form the caller typed", () => {
    // Issue and verify must agree because both sides canonicalize first.
    const canonical = toCanonicalIranPhone("09123456789")!
    const challenge = generateOtpChallenge("login", canonical)
    const verifyPhone = toCanonicalIranPhone("+98 912 345 6789")!
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", verifyPhone, challenge.developmentCode),
    ).toEqual({ ok: true })
  })

  it("rejects a wrong code", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    const wrong = challenge.developmentCode === "000000" ? "111111" : "000000"
    expect(consumeOtpChallenge(challenge.challengeToken, "login", PHONE, wrong)).toEqual({
      ok: false,
      reason: "wrong_code",
    })
  })

  it("rejects a valid code presented with a different phone", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", "+989350000000", challenge.developmentCode),
    ).toEqual({ ok: false, reason: "mismatch" })
  })

  it("rejects a signup code replayed as a login code", () => {
    const challenge = generateOtpChallenge("signup", PHONE, "مریم احمدی")
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: false, reason: "mismatch" })
  })

  it("rejects a signup code bound to a different parent name", () => {
    const challenge = generateOtpChallenge("signup", PHONE, "مریم احمدی")
    expect(
      consumeOtpChallenge(challenge.challengeToken, "signup", PHONE, challenge.developmentCode, "علی رضایی"),
    ).toEqual({ ok: false, reason: "mismatch" })
  })

  it("rejects a tampered or garbage challenge token", () => {
    expect(consumeOtpChallenge("not-a-token", "login", PHONE, "123456").ok).toBe(false)

    const challenge = generateOtpChallenge("login", PHONE)
    const decoded = JSON.parse(Buffer.from(challenge.challengeToken, "base64url").toString())
    decoded.signed = decoded.signed.replace(/"code":"\d{6}"/, '"code":"000000"')
    const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url")

    expect(consumeOtpChallenge(forged, "login", PHONE, "000000")).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  it("rejects a token signed with a different secret", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    const original = process.env.DEV_PARENT_AUTH_SECRET
    process.env.DEV_PARENT_AUTH_SECRET = "b".repeat(64)
    try {
      expect(
        consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
      ).toEqual({ ok: false, reason: "bad_signature" })
    } finally {
      process.env.DEV_PARENT_AUTH_SECRET = original
    }
  })
})

describe("dev OTP lifetime", () => {
  it("stays valid for its documented lifetime", () => {
    vi.useFakeTimers()
    const challenge = generateOtpChallenge("login", PHONE)
    vi.advanceTimersByTime((challenge.expiresInSeconds - 1) * 1000)
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: true })
  })

  it("rejects an expired code as expired, not as wrong", () => {
    vi.useFakeTimers()
    const challenge = generateOtpChallenge("login", PHONE)
    vi.advanceTimersByTime((challenge.expiresInSeconds + 1) * 1000)
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: false, reason: "expired" })
  })
})

describe("dev OTP consumption", () => {
  it("does not consume the challenge on a failed attempt", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    const wrong = challenge.developmentCode === "000000" ? "111111" : "000000"

    expect(consumeOtpChallenge(challenge.challengeToken, "login", PHONE, wrong).ok).toBe(false)
    // The displayed code must still work afterwards.
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: true })
  })

  it("cannot be reused after a successful consumption", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: true })
    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: false, reason: "already_used" })
  })

  it("burns the challenge after too many wrong guesses", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    const wrong = challenge.developmentCode === "000000" ? "111111" : "000000"

    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
      expect(consumeOtpChallenge(challenge.challengeToken, "login", PHONE, wrong).ok).toBe(false)
    }

    expect(
      consumeOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode),
    ).toEqual({ ok: false, reason: "too_many_attempts" })
  })

  it("keeps the pure predicate free of state effects", () => {
    const challenge = generateOtpChallenge("login", PHONE)
    expect(verifyOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode)).toBe(true)
    expect(verifyOtpChallenge(challenge.challengeToken, "login", PHONE, challenge.developmentCode)).toBe(true)
  })

  it("issues a distinct code per challenge", () => {
    const codes = new Set(
      Array.from({ length: 25 }, () => generateOtpChallenge("login", PHONE).challengeToken),
    )
    expect(codes.size).toBe(25)
  })
})

describe("dev auth activation guards", () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV
    process.env.DEV_PARENT_AUTH_ENABLED = saved.DEV_PARENT_AUTH_ENABLED
    process.env.DEV_PARENT_AUTH_SECRET = saved.DEV_PARENT_AUTH_SECRET
  })

  it("is off in production even when explicitly enabled", () => {
    process.env.NODE_ENV = "production"
    process.env.DEV_PARENT_AUTH_ENABLED = "true"
    process.env.DEV_PARENT_AUTH_SECRET = "a".repeat(64)
    expect(isDevAuthEnabled()).toBe(false)
  })

  it("is off unless explicitly enabled", () => {
    process.env.NODE_ENV = "development"
    process.env.DEV_PARENT_AUTH_SECRET = "a".repeat(64)

    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      if (value === undefined) delete process.env.DEV_PARENT_AUTH_ENABLED
      else process.env.DEV_PARENT_AUTH_ENABLED = value
      expect(isDevAuthEnabled(), String(value)).toBe(false)
    }

    process.env.DEV_PARENT_AUTH_ENABLED = "true"
    expect(isDevAuthEnabled()).toBe(true)
  })

  it("is off when the secret is missing or too weak", () => {
    process.env.NODE_ENV = "development"
    process.env.DEV_PARENT_AUTH_ENABLED = "true"

    delete process.env.DEV_PARENT_AUTH_SECRET
    expect(isDevAuthEnabled()).toBe(false)

    process.env.DEV_PARENT_AUTH_SECRET = "a".repeat(31)
    expect(isDevAuthEnabled()).toBe(false)

    process.env.DEV_PARENT_AUTH_SECRET = "a".repeat(32)
    expect(isDevAuthEnabled()).toBe(true)
  })

  it("only treats loopback hosts as local", () => {
    expect(isLocalhost("localhost:3000")).toBe(true)
    expect(isLocalhost("127.0.0.1:3000")).toBe(true)
    expect(isLocalhost("cartoona.ir")).toBe(false)
    expect(isLocalhost("localhost.evil.com")).toBe(false)
  })
})

import { describe, it, expect } from "vitest"
import {
  DEFAULT_SESSION_POLICY,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_EVIDENCE_SKEW_MS,
  evaluateSessionPolicy,
  secondsToInstant,
} from "@/lib/identity/session-policy"
import { readSupabaseSessionEvidence } from "@/lib/auth/supabase-session-evidence"
import { accessToken, DAY_MS } from "../helpers/supabase-jwt"

/**
 * The provider-neutral session policy (lib/identity/session-policy.ts) and the
 * Supabase claim reader that feeds it. Pure; the clock is always passed in.
 */

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const policy = (sessionsNotBefore: number | null = null) => ({ ...DEFAULT_SESSION_POLICY, sessionsNotBefore })
const decide = (authenticatedAt: number, sessionsNotBefore: number | null = null, now = NOW) =>
  evaluateSessionPolicy({ authenticatedAt }, policy(sessionsNotBefore), now)

describe("absolute lifetime: 30 days from sign-in", () => {
  it("is 30 days", () => {
    expect(SESSION_ABSOLUTE_LIFETIME_MS).toBe(30 * DAY_MS)
    expect(DEFAULT_SESSION_POLICY).toEqual({ absoluteLifetimeMs: 30 * DAY_MS, sessionsNotBefore: null })
  })

  it("1. a fresh session is valid, and reports when it ends", () => {
    expect(decide(NOW - 60_000)).toEqual({ status: "valid", expiresAt: NOW - 60_000 + 30 * DAY_MS })
  })

  it("2. one millisecond before 30 days: valid", () => {
    expect(decide(NOW - 30 * DAY_MS + 1).status).toBe("valid")
  })

  it("3. exactly at 30 days: expired (now >= authenticatedAt + 30d)", () => {
    expect(decide(NOW - 30 * DAY_MS)).toEqual({ status: "expired" })
  })

  it("4. older than 30 days: expired", () => {
    expect(decide(NOW - 31 * DAY_MS)).toEqual({ status: "expired" })
    expect(decide(NOW - 365 * DAY_MS)).toEqual({ status: "expired" })
  })
})

describe("forced invalidation: sessions_not_before", () => {
  it("5. null: never invalidated", () => {
    expect(decide(NOW - 29 * DAY_MS, null).status).toBe("valid")
  })

  it("6. signed in before the cut-off: invalidated", () => {
    expect(decide(NOW - 2 * DAY_MS, NOW - DAY_MS)).toEqual({ status: "invalidated" })
  })

  it("7. signed in exactly AT the cut-off: valid (documented boundary)", () => {
    const cutoff = NOW - DAY_MS
    expect(decide(cutoff, cutoff).status).toBe("valid")
    expect(decide(cutoff - 1, cutoff)).toEqual({ status: "invalidated" })
  })

  it("a sub-second cut-off is rounded UP: a sign-in in that same second counts as before it", () => {
    const second = NOW - DAY_MS // whole second
    expect(decide(second, second + 400)).toEqual({ status: "invalidated" })
    expect(decide(second + 1000, second + 400).status).toBe("valid")
  })

  it("a sign-in after the cut-off is valid; invalidation is checked before expiry", () => {
    expect(decide(NOW - 1000, NOW - DAY_MS).status).toBe("valid")
    expect(decide(NOW - 40 * DAY_MS, NOW - DAY_MS)).toEqual({ status: "invalidated" })
  })
})

describe("evidence and clock", () => {
  it("8. timestamps: unix seconds normalise to epoch ms, UTC", () => {
    expect(secondsToInstant(1_760_000_000)).toBe(1_760_000_000_000)
    expect(new Date(secondsToInstant(1_760_000_000)).toISOString()).toBe("2025-10-09T08:53:20.000Z")
  })

  it("9. the clock is injected: the same evidence is valid now and expired later", () => {
    const signedIn = NOW - 10 * DAY_MS
    expect(decide(signedIn, null, NOW).status).toBe("valid")
    expect(decide(signedIn, null, NOW + 20 * DAY_MS)).toEqual({ status: "expired" })
  })

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["a string", "1760000000000"],
    ["undefined", undefined],
    ["beyond the future skew", NOW + SESSION_EVIDENCE_SKEW_MS + 1],
  ])("10. malformed evidence (%s) is rejected as invalid_evidence, never valid", (_label, value) => {
    expect(evaluateSessionPolicy({ authenticatedAt: value as number }, policy(), NOW)).toEqual({ status: "invalid_evidence" })
  })

  it("within the skew a slightly-ahead provider clock is tolerated", () => {
    expect(decide(NOW + SESSION_EVIDENCE_SKEW_MS).status).toBe("valid")
  })

  it("invalid policy inputs are programming errors, not silent passes", () => {
    expect(() => evaluateSessionPolicy({ authenticatedAt: NOW }, policy(), Number.NaN)).toThrow(TypeError)
    expect(() => evaluateSessionPolicy({ authenticatedAt: NOW }, { absoluteLifetimeMs: 0, sessionsNotBefore: null }, NOW)).toThrow(TypeError)
    expect(() => evaluateSessionPolicy({ authenticatedAt: NOW }, policy(Number.NaN), NOW)).toThrow(TypeError)
  })
})

describe("readSupabaseSessionEvidence (decode only; callers verify first)", () => {
  const SUB = "6f1c2e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50"

  it("sign-in time = the EARLIEST amr timestamp, in ms; never iat", () => {
    const token = accessToken({
      sub: SUB,
      authenticatedAt: 0,
      issuedAt: NOW, // a just-refreshed token
      amr: [{ method: "totp", timestamp: 1_760_000_500 }, { method: "otp", timestamp: 1_760_000_000 }],
    })
    expect(readSupabaseSessionEvidence(token)).toEqual({
      subject: SUB,
      sessionId: "5e5e5e5e-0000-4000-8000-000000000001",
      authenticatedAt: 1_760_000_000_000,
    })
  })

  it("ignores token_refresh entries and entries without a usable timestamp", () => {
    const token = accessToken({
      sub: SUB, authenticatedAt: 0,
      amr: [{ method: "token_refresh", timestamp: 1_000 }, { method: "otp", timestamp: "x" }, null, "password", { method: "password", timestamp: 1_760_000_000 }],
    })
    expect(readSupabaseSessionEvidence(token)?.authenticatedAt).toBe(1_760_000_000_000)
  })

  it.each([
    ["not a string", 42],
    ["not a JWT", "abc"],
    ["bad base64", "a.$$$.c"],
    ["payload not JSON", `a.${Buffer.from("nope").toString("base64url")}.c`],
    ["no sub", accessToken({ sub: "", authenticatedAt: NOW })],
    ["no amr", accessToken({ sub: SUB, authenticatedAt: NOW, amr: undefined as never }).replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ sub: SUB, session_id: "s" })).toString("base64url")}.`)],
    ["string-only amr", accessToken({ sub: SUB, authenticatedAt: NOW, amr: ["otp", "password"] })],
    ["empty amr", accessToken({ sub: SUB, authenticatedAt: NOW, amr: [] })],
    ["oversized token", "a." + "b".repeat(20_000) + ".c"],
  ])("fails closed on %s", (_label, token) => {
    expect(readSupabaseSessionEvidence(token)).toBeNull()
  })

  it("requires a session_id", () => {
    const payload = Buffer.from(JSON.stringify({ sub: SUB, amr: [{ method: "otp", timestamp: 1_760_000_000 }] })).toString("base64url")
    expect(readSupabaseSessionEvidence(`h.${payload}.s`)).toBeNull()
  })
})

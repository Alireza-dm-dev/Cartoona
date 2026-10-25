import { describe, expect, it } from "vitest"
import { analyzeAmr, decodeClaims } from "../../scripts/auth/amr-analysis.mjs"

const claims = (iat: number, amr: unknown) => ({ iat, amr, sub: "SECRET-SUBJECT", phone: "+98SECRET", email: "x@y.z", session_id: "SECRET-SESSION" })

describe("AMR verification analysis (V0.1.54)", () => {
  it("stable: timestamp present and unchanged by a refresh", () => {
    const r = analyzeAmr(claims(100, [{ method: "otp", timestamp: 90 }]), claims(200, [{ method: "otp", timestamp: 90 }, { method: "token_refresh", timestamp: 190 }]))
    expect(r).toMatchObject({ stable: true, methods: ["otp"], timestampPresent: true, iatChangedOnRefresh: true, earliestAmrStableAcrossRefresh: true, issues: [] })
  })

  it.each([
    ["no amr", claims(1, undefined), claims(2, undefined), ["amr_missing"]],
    ["amr without timestamp", claims(1, [{ method: "password" }]), claims(2, [{ method: "password" }]), ["amr_timestamp_missing"]],
    ["timestamp moves on refresh", claims(1, [{ method: "password", timestamp: 10 }]), claims(2, [{ method: "password", timestamp: 20 }]), ["earliest_amr_timestamp_moved_on_refresh"]],
    ["timestamp lost on refresh", claims(1, [{ method: "password", timestamp: 10 }]), claims(2, []), ["amr_timestamp_lost_after_refresh"]],
    ["refresh kept the same iat", claims(5, [{ method: "password", timestamp: 10 }]), claims(5, [{ method: "password", timestamp: 10 }]), ["refresh_did_not_change_iat"]],
  ])("unstable: %s", (_n, a, b, issues) => {
    const r = analyzeAmr(a, b)
    expect(r.stable).toBe(false)
    expect(r.issues).toEqual(issues)
  })

  it("never echoes an identifier, phone, e-mail, session id or absolute time", () => {
    const text = JSON.stringify(analyzeAmr(claims(100, [{ method: "otp", timestamp: 90 }]), claims(200, [{ method: "otp", timestamp: 90 }])))
    expect(text).not.toMatch(/SECRET|@|\+98|"timestamp"/)
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["amrAgeSecondsAtCheck", "amrPresent", "earliestAmrStableAcrossRefresh", "iatChangedOnRefresh", "issues", "methods", "stable", "timestampPresent"])
  })

  it("decodeClaims reads the payload only", () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ iat: 1 })).toString("base64url")}.s`
    expect(decodeClaims(jwt)).toEqual({ iat: 1 })
  })

  it("the operator script refuses production and prints no credential", async () => {
    const fs = await import("node:fs")
    const src = fs.readFileSync("scripts/auth/verify-amr.mjs", "utf8")
    expect(src).toMatch(/PRODUCTION_REFS/)
    expect(src).toMatch(/refuse\("production project"\)/)
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/out\([^)]*(access_token|refresh_token|\.user\b|session\.user)/)
  })
})

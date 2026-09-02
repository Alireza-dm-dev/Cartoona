import { describe, test, expect, beforeEach } from "vitest"

const MAIN_REF = "oucyhmrnzahlhqjfqcge"
const MIGRATION_TEST_REF = "guhhlshjvmiwwmixiulk"
const DISPOSABLE_REF = "abcdefghijklmnopqrst"
const OTHER_REF = "xyzzzzzzzzzzzzzzzzzz"

let envBackup: Record<string, string | undefined> = {}

beforeEach(() => {
  envBackup = {}
  for (const key of [
    "SUPABASE_PROJECT_REF",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_URL",
    "CARTOONA_ALLOW_DESTRUCTIVE_TESTS",
    "CARTOONA_TEST_SUPABASE_PROJECT_REF",
  ]) {
    envBackup[key] = process.env[key]
  }
})

function cleanup() {
  for (const [key, val] of Object.entries(envBackup)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
}

function clearEnv(keys: string[]) {
  for (const k of keys) {
    delete process.env[k]
  }
}

interface GuardModule {
  assertSafeDatabaseTarget: () => { ok: boolean; reason: string; kind: string }
}

async function loadGuard(): Promise<GuardModule> {
  return import("@/tests/helpers/assert-safe-database-target") as Promise<GuardModule>
}

describe("assertSafeDatabaseTarget", () => {
  // ── 1–3. Main project rejection ──────────────────────────────────
  test("1. Main URL alone → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${MAIN_REF}.supabase.co`
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("main")
    cleanup()
  })

  test("2. Main URL with opt-in → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${MAIN_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("main")
    cleanup()
  })

  test("3. Main URL plus disposable secondary URL → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${MAIN_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("main")
    cleanup()
  })

  test("4. Main project ref plus disposable URL → rejected", async () => {
    clearEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.SUPABASE_PROJECT_REF = MAIN_REF
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("main")
    cleanup()
  })

  // ── 5–7. Migration Test project rejection ────────────────────────
  test("5. Migration Test URL alone → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${MIGRATION_TEST_REF}.supabase.co`
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("forbidden_known_project")
    cleanup()
  })

  test("6. Migration Test URL plus disposable secondary URL → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${MIGRATION_TEST_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("forbidden_known_project")
    cleanup()
  })

  test("7. Migration Test project ref plus disposable URL → rejected", async () => {
    clearEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.SUPABASE_PROJECT_REF = MIGRATION_TEST_REF
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("forbidden_known_project")
    cleanup()
  })

  // ── 8. Same ref via both URL vars ────────────────────────────────
  test("8. NEXT_PUBLIC_SUPABASE_URL and SUPABASE_URL same hosted ref → accepted with test ref + opt-in", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("explicit_disposable")
    cleanup()
  })

  // ── 9. Conflicting hosted URLs ───────────────────────────────────
  test("9. NEXT_PUBLIC_SUPABASE_URL and SUPABASE_URL different refs → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${OTHER_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    expect(result.reason).toContain("disagree")
    cleanup()
  })

  // ── 10. Hosted URL and SUPABASE_PROJECT_REF disagree ────────────
  test("10. Hosted URL and SUPABASE_PROJECT_REF disagree → rejected", async () => {
    clearEnv(["SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.SUPABASE_PROJECT_REF = OTHER_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    expect(result.reason).toContain("disagree")
    cleanup()
  })

  // ── 11. Hosted URL and explicit test ref disagree ───────────────
  test("11. Hosted URL and explicit test ref disagree → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = OTHER_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    expect(result.reason).toContain("disagree")
    cleanup()
  })

  // ── 12. SUPABASE_PROJECT_REF and test ref disagree ──────────────
  test("12. SUPABASE_PROJECT_REF and explicit test ref disagree → rejected", async () => {
    clearEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = OTHER_REF
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    expect(result.reason).toContain("disagree")
    cleanup()
  })

  // ── 13. Local + hosted mix ───────────────────────────────────────
  test("13. Local URL plus hosted URL → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    expect(result.reason).toContain("disagree")
    cleanup()
  })

  // ── 14–15. Equivalent local hosts ────────────────────────────────
  test("14. localhost and 127.0.0.1 same port → accepted with opt-in", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
    process.env.SUPABASE_URL = "http://127.0.0.1:54321"
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("local")
    cleanup()
  })

  test("15. localhost and ::1 same port → accepted with opt-in", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
    process.env.SUPABASE_URL = "http://[::1]:54321"
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("local")
    cleanup()
  })

  // ── 16. Different local ports ────────────────────────────────────
  test("16. Local identifiers with different ports → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
    process.env.SUPABASE_URL = "http://localhost:54322"
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    expect(result.reason).toContain("disagree")
    cleanup()
  })

  // ── 17. Local without opt-in ─────────────────────────────────────
  test("17. Local without opt-in → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("local")
    expect(result.reason).toContain("CARTOONA_ALLOW_DESTRUCTIVE_TESTS")
    cleanup()
  })

  // ── 18–20. Explicit disposable behavior ──────────────────────────
  test("18. Arbitrary hosted project without explicit test ref → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  test("19. Exact disposable hosted target with opt-in → accepted", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("explicit_disposable")
    cleanup()
  })

  test("20. Exact disposable target without opt-in → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("explicit_disposable")
    expect(result.reason).toContain("CARTOONA_ALLOW_DESTRUCTIVE_TESTS")
    cleanup()
  })

  // ── 21–22. Empty/whitespace variables ────────────────────────────
  test("21. Empty-string variables are ignored as absent", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = ""
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("explicit_disposable")
    cleanup()
  })

  test("22. Whitespace-only variables are ignored as absent", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = "   "
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("explicit_disposable")
    cleanup()
  })

  // ── 23–26. URL component rejection ──────────────────────────────
  test("23. URL containing a path → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co/path`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  test("24. URL containing query → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co?x=1`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  test("25. URL containing fragment → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co#frag`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  test("26. URL containing credentials → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://user:pass@${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  // ── 27. Lookalike hostname ───────────────────────────────────────
  test("27. Lookalike Supabase hostname → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co.evil.com`
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  // ── 28. Uppercase hostname ───────────────────────────────────────
  test("28. Uppercase hostname normalizes safely", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `HTTPS://${DISPOSABLE_REF.toUpperCase()}.SUPABASE.CO`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("explicit_disposable")
    cleanup()
  })

  // ── 29. Malformed URL ───────────────────────────────────────────
  test("29. Malformed URL → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "NEXT_PUBLIC_SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    process.env.SUPABASE_URL = "not-a-url"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  // ── 30. All identifiers absent ───────────────────────────────────
  test("30. All identifiers absent → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS", "CARTOONA_TEST_SUPABASE_PROJECT_REF"])
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unknown")
    cleanup()
  })

  // ── 31. Duplicate equivalent hosted identifiers ─────────────────
  test("31. Duplicate equivalent hosted identifiers → accepted under disposable rules", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "SUPABASE_URL", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co` // dup
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(true)
    expect(result.kind).toBe("explicit_disposable")
    cleanup()
  })

  // ── 32–33. NEXT_PUBLIC vs SUPABASE_URL cross-swap ───────────────
  test("32. NEXT_PUBLIC URL disposable while SUPABASE_URL main → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${MAIN_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("main")
    cleanup()
  })

  test("33. NEXT_PUBLIC URL main while SUPABASE_URL disposable → rejected", async () => {
    clearEnv(["SUPABASE_PROJECT_REF", "CARTOONA_ALLOW_DESTRUCTIVE_TESTS"])
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${MAIN_REF}.supabase.co`
    process.env.SUPABASE_URL = `https://${DISPOSABLE_REF}.supabase.co`
    process.env.CARTOONA_TEST_SUPABASE_PROJECT_REF = DISPOSABLE_REF
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const { assertSafeDatabaseTarget } = await loadGuard()
    const result = assertSafeDatabaseTarget()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("main")
    cleanup()
  })
})

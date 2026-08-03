#!/usr/bin/env node

const MAIN_REF = "oucyhmrnzahlhqjfqcge"
const MIGRATION_TEST_REF = "guhhlshjvmiwwmixiulk"
const DISPOSABLE_REF = "abcdefghijklmnopqrst"
const OTHER_REF = "xyzzzzzzzzzzzzzzzzzz"

async function main() {
  const failures: string[] = []

  function check(label: string, ok: boolean, detail?: string) {
    if (!ok) {
      failures.push(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
      console.log(`  ✓ ${label}`)
    }
  }

  async function runTest(
    label: string,
    env: Record<string, string>,
    expectOk: boolean,
    expectKind?: string,
  ) {
    for (const k of Object.keys(process.env)) {
      if (k.includes("SUPABASE") || k.startsWith("CARTOONA_")) {
        delete process.env[k]
      }
    }
    for (const [k, v] of Object.entries(env)) {
      process.env[k] = v
    }

    const mod = await import("./assert-safe-database-target")
    const result = mod.assertSafeDatabaseTarget()

    check(
      label,
      result.ok === expectOk,
      `expected ok=${expectOk} kind=${expectKind ?? "?"}, got ok=${result.ok} kind=${result.kind}: ${result.reason}`,
    )
  }

  console.log("\nGuard smoke test\n")

  // ── Main hidden behind secondary disposable identifier ──────────
  await runTest(
    "A: Main hidden behind secondary disposable identifier → rejected (kind=main)",
    {
      NEXT_PUBLIC_SUPABASE_URL: `https://${MAIN_REF}.supabase.co`,
      SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      CARTOONA_TEST_SUPABASE_PROJECT_REF: DISPOSABLE_REF,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "main",
  )

  // ── Migration Test hidden behind secondary identifier ──────────
  await runTest(
    "B: Migration Test hidden behind disposable URL → rejected (kind=forbidden_known_project)",
    {
      NEXT_PUBLIC_SUPABASE_URL: `https://${MIGRATION_TEST_REF}.supabase.co`,
      SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      CARTOONA_TEST_SUPABASE_PROJECT_REF: DISPOSABLE_REF,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "forbidden_known_project",
  )

  // ── Two conflicting hosted URLs ────────────────────────────────
  await runTest(
    "C: Two conflicting hosted URLs → rejected (kind=unknown)",
    {
      NEXT_PUBLIC_SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      SUPABASE_URL: `https://${OTHER_REF}.supabase.co`,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "unknown",
  )

  // ── URL/project-ref conflict ───────────────────────────────────
  await runTest(
    "D: URL and SUPABASE_PROJECT_REF disagree → rejected",
    {
      NEXT_PUBLIC_SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      SUPABASE_PROJECT_REF: OTHER_REF,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "unknown",
  )

  // ── URL/explicit-test-ref conflict ─────────────────────────────
  await runTest(
    "E: URL and CARTOONA_TEST_SUPABASE_PROJECT_REF disagree → rejected",
    {
      NEXT_PUBLIC_SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      CARTOONA_TEST_SUPABASE_PROJECT_REF: OTHER_REF,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "unknown",
  )

  // ── Local/hosted conflict ──────────────────────────────────────
  await runTest(
    "F: Local URL + hosted URL → rejected",
    {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "unknown",
  )

  // ── Equivalent local loopback hosts ────────────────────────────
  await runTest(
    "G: localhost and 127.0.0.1 same port → accepted (local)",
    {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_URL: "http://127.0.0.1:54321",
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    true, "local",
  )

  // ── Different local ports ──────────────────────────────────────
  await runTest(
    "H: Different local ports → rejected",
    {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_URL: "http://localhost:54322",
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    false, "unknown",
  )

  // ── Exact explicit disposable acceptance ───────────────────────
  await runTest(
    "I: Exact match URL + test ref + opt-in → accepted (explicit_disposable)",
    {
      NEXT_PUBLIC_SUPABASE_URL: `https://${DISPOSABLE_REF}.supabase.co`,
      CARTOONA_TEST_SUPABASE_PROJECT_REF: DISPOSABLE_REF,
      CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
    },
    true, "explicit_disposable",
  )

  // ── Unknown rejection ──────────────────────────────────────────
  await runTest(
    "J: No identifiers → rejected (unknown)",
    {},
    false, "unknown",
  )

  console.log()

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`)
    for (const f of failures) {
      console.error(`  ${f}`)
    }
    process.exit(1)
  }

  console.log("All smoke checks passed.")
  process.exit(0)
}

main()

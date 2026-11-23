// Guard against silently skipped tests in CI (V0.1.56).
//
//   node scripts/ci/check-test-baseline.mjs <vitest-json-report>
//
// The real-PostgreSQL suites are opt-in (CARTOONA_PLAIN_PG=docker). If the
// database did not come up or the variable were lost, they would SKIP, and a
// plain "0 failed" would still look green. So CI also requires at least
// MIN_PASSED passing tests and at most MAX_SKIPPED skipped ones. Raise
// MIN_PASSED when tests are added; never lower it to make CI pass.
import fs from "node:fs"

const MIN_PASSED = Number(process.env.CARTOONA_MIN_PASSED_TESTS ?? 3420)
const MAX_SKIPPED = Number(process.env.CARTOONA_MAX_SKIPPED_TESTS ?? 37)

// Tests that legitimately cannot run on a CI runner, approved by name. Each one
// tests a developer's own untracked file, so it is skipped by design whenever
// that file is absent. The allowance applies ONLY when CI=true, ONLY to a test
// matching file + title below, and shifts the baseline by exactly the number of
// them that were actually skipped (one passed test becomes one skipped test).
// Any other skipped or missing test still fails the gate. Add an entry only with
// explicit approval and a reason.
const CI_ONLY_SKIPS = [
  {
    file: "tests/unit/test-env-resolution.test.ts",
    title: "this checkout's .env.local: Next, the helper and the guard agree on one project",
    reason: "validates the developer's gitignored .env.local, which never exists on a runner",
  },
]
const inCI = process.env.CI === "true"

const file = process.argv[2]
if (!file) {
  console.error("usage: check-test-baseline.mjs <vitest-json-report>")
  process.exit(2)
}
const r = JSON.parse(fs.readFileSync(file, "utf8"))
const passed = r.numPassedTests ?? 0
const failed = r.numFailedTests ?? 0
const skipped = (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0)
const allowed = inCI
  ? (r.testResults ?? []).flatMap((f) =>
      (f.assertionResults ?? [])
        .filter((a) => ["pending", "skipped", "todo"].includes(a.status))
        .filter((a) => CI_ONLY_SKIPS.some((e) => f.name.endsWith(e.file) && (a.title ?? "") === e.title)),
    ).length
  : 0
const minPassed = MIN_PASSED - allowed
const maxSkipped = MAX_SKIPPED + allowed
const line = `tests: ${passed} passed, ${failed} failed, ${skipped} skipped (baseline: >= ${minPassed} passed, <= ${maxSkipped} skipped${allowed ? `; includes ${allowed} approved CI-only skip` : ""})`
console.log(line)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Vitest\n\n${line}\n`)

const problems = []
if (failed > 0) problems.push(`${failed} test(s) failed`)
if (passed < minPassed) problems.push(`only ${passed} passed; the baseline is ${minPassed} (were suites skipped?)`)
if (skipped > maxSkipped) problems.push(`${skipped} skipped; the baseline allows ${maxSkipped}`)
for (const p of problems) console.log(`::error::${p}`)
process.exit(problems.length ? 1 : 0)

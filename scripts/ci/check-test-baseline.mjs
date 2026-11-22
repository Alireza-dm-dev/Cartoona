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

const MIN_PASSED = Number(process.env.CARTOONA_MIN_PASSED_TESTS ?? 3403)
const MAX_SKIPPED = Number(process.env.CARTOONA_MAX_SKIPPED_TESTS ?? 37)

const file = process.argv[2]
if (!file) {
  console.error("usage: check-test-baseline.mjs <vitest-json-report>")
  process.exit(2)
}
const r = JSON.parse(fs.readFileSync(file, "utf8"))
const passed = r.numPassedTests ?? 0
const failed = r.numFailedTests ?? 0
const skipped = (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0)
const line = `tests: ${passed} passed, ${failed} failed, ${skipped} skipped (baseline: >= ${MIN_PASSED} passed, <= ${MAX_SKIPPED} skipped)`
console.log(line)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Vitest\n\n${line}\n`)

const problems = []
if (failed > 0) problems.push(`${failed} test(s) failed`)
if (passed < MIN_PASSED) problems.push(`only ${passed} passed; the baseline is ${MIN_PASSED} (were suites skipped?)`)
if (skipped > MAX_SKIPPED) problems.push(`${skipped} skipped; the baseline allows ${MAX_SKIPPED}`)
for (const p of problems) console.log(`::error::${p}`)
process.exit(problems.length ? 1 : 0)

#!/usr/bin/env node
/**
 * Production configuration preflight (V0.1.55). Validates the environment of
 * the process it runs in - nothing else: no network, no database, no file is
 * written, no value is printed.
 *
 *   node scripts/ops/production-preflight.mjs --service frontend|backend
 *        [--payments required] [--expect-freeze on|off] [--allow-plaintext-private-db]
 *
 * Run it with the same environment the service will start with (for example
 * `env -i $(cat service.env) node ...` or inside the container). Exit 0 = no
 * failing check (warnings allowed), 1 = at least one failure, 2 = bad usage.
 */
import { runPreflight } from "./production-preflight-core.mjs"

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const service = arg("--service")
const expectFreeze = arg("--expect-freeze") ?? null
if (!["frontend", "backend"].includes(service) || ![null, "on", "off"].includes(expectFreeze)) {
  process.stderr.write("usage: production-preflight.mjs --service frontend|backend [--payments required] [--expect-freeze on|off] [--allow-plaintext-private-db]\n")
  process.exit(2)
}

const result = runPreflight(process.env, {
  service,
  payments: arg("--payments") === "required",
  expectFreeze,
  allowPlaintextPrivateDb: process.argv.includes("--allow-plaintext-private-db"),
})
for (const c of result.checks) process.stdout.write(`${c.status.toUpperCase().padEnd(4)} ${c.id}: ${c.detail}\n`)
const failed = result.checks.filter((c) => c.status === "fail").length
const warned = result.checks.filter((c) => c.status === "warn").length
process.stdout.write(`\npreflight(${service}): ${result.ok ? "OK" : "FAILED"} - ${result.checks.length} checks, ${failed} failed, ${warned} warnings\n`)
process.exit(result.ok ? 0 : 1)

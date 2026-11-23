import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { composeService, composeServiceNames, withoutYamlComments } from "../helpers/compose-text"

/**
 * Static guards for the deployment hardening patch (docs/CI_CD.md). The
 * behaviour itself (approval expiry, mismatches, replay, rollback
 * authorization, ownership, port exposure) is exercised against a real Docker
 * stack in the Linux rehearsal described in that document; these tests keep the
 * rules that make it safe from being edited away unnoticed.
 */
const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const script = read("deploy/server/cartoona-deploy")
const scriptCode = script.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n")
const wrapper = read("deploy/server/cartoona-deploy-ssh")
const sudoers = read("deploy/server/sudoers.cartoona-deploy")
const workflow = read(".github/workflows/deploy.yml")

/** `- "..."` entries under a service's `ports:` (short syntax). */
function ports(block: string): string[] {
  const lines = block.split("\n")
  const start = lines.findIndex((l) => /^\s+ports:/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s*"?([^"]+)"?\s*$/.exec(line)
    if (!m) break
    out.push(m[1])
  }
  return out
}

describe("every published port is loopback-only (compose.yml and the production overlay)", () => {
  const base = withoutYamlComments(read("compose.yml"))
  const overlay = withoutYamlComments(read("deploy/compose.production.yml"))

  it.each(composeServiceNames(base))("compose.yml: %s", (name) => {
    for (const p of ports(composeService(base, name))) expect(p, `${name}: ${p}`).toMatch(/^127\.0\.0\.1:\d+:\d+$/)
  })

  it("the three published services keep their expected loopback mappings", () => {
    expect(ports(composeService(base, "frontend"))).toEqual(["127.0.0.1:3000:3000"])
    expect(ports(composeService(base, "backend"))).toEqual(["127.0.0.1:4000:4000"])
    expect(ports(composeService(base, "postgres"))).toEqual(["127.0.0.1:5433:5432"])
  })

  it("the overlay still forces the frontend onto loopback (defense in depth)", () => {
    expect(overlay).toMatch(/ports: !override/)
    expect(ports(composeService(overlay, "frontend"))).toEqual(["127.0.0.1:3000:3000"])
  })

  it("no service uses host networking", () => {
    expect(base).not.toMatch(/network_mode:\s*host/)
    expect(overlay).not.toMatch(/network_mode:\s*host/)
  })
})

describe("cartoona-deploy: approval, authorization and safety rules", () => {
  it("uses explicit /bin/bash in the script and the forced command", () => {
    expect(script.split("\n")[0]).toBe("#!/bin/bash")
    expect(wrapper.split("\n")[0]).toBe("#!/bin/bash")
  })

  it("keeps its lock inside the root-only state directory, not /run/lock", () => {
    expect(script).toMatch(/readonly LOCK_FILE=\$STATE_DIR\/lock/)
    expect(scriptCode).not.toContain("/run/lock")
  })

  it("requires every GO field, the exact commit and both digests, and caps validity at 72 h", () => {
    for (const f of ["decision", "approval_id", "approved_by", "approved_at", "expires_at", "reference", "release_sha", "frontend_digest", "backend_digest"]) {
      expect(script, f).toContain(f)
    }
    expect(script).toMatch(/GO_MAX_SECONDS=259200/)
    expect(script).toContain('"$(go_value release_sha)" = "$SHA"')
    expect(script).toContain('"$(go_value frontend_digest)" = "${FRONTEND_REF#*@}"')
    expect(script).toContain('"$(go_value backend_digest)" = "${BACKEND_REF#*@}"')
  })

  it("has no freeze-off exception: the freeze is always required, and the old key is refused", () => {
    expect(scriptCode).not.toContain("expected_freeze")
    expect(script).toContain("obsolete (CI always requires the freeze ON)")
    expect(scriptCode).toMatch(/CARTOONA_WRITE_FREEZE must be set exactly once to 1/)
  })

  it("consumes the approval atomically, after the checks and before any tag or container change", () => {
    expect(script).toMatch(/mkdir -m 0700 "\$CONSUMED_DIR\/\$id"/)
    const deploy = script.slice(script.indexOf("cmd_deploy() {"), script.indexOf("ROLLBACK_REASON=\"\""))
    const iCheck = deploy.indexOf("preflight_checks")
    const iConsume = deploy.indexOf("go_consume ||")
    const iTag = deploy.indexOf('docker tag "$prev_front"')
    const iApply = deploy.indexOf("apply_tags")
    expect(iCheck).toBeGreaterThan(-1)
    expect(iConsume).toBeGreaterThan(iCheck)
    expect(iTag).toBeGreaterThan(iConsume)
    expect(iApply).toBeGreaterThan(iTag)
    // the approval is also checked before any image is pulled
    expect(deploy.indexOf("go_check ||")).toBeLessThan(iCheck)
  })

  it("restricts CI rollback to the release it deployed most recently; administrators are unrestricted", () => {
    expect(script).toContain("ROLLBACK_WINDOW_SECONDS=3600")
    expect(script).toMatch(/caller_is_ci\(\)/)
    expect(script).toContain('SUDO_USER:-}" = "$DEPLOY_USER"')
    expect(script).toContain("SUDO_UID")
    for (const rule of ["deployed_by", "approval_id", "rolled_back", "recorded_epoch"]) expect(script).toContain(rule)
    const rollback = script.slice(script.indexOf("cmd_rollback() {"), script.indexOf("main() {"))
    expect(rollback).toMatch(/if caller_is_ci; then\s+ci_rollback_allowed/)
    expect(rollback).not.toContain("go_check")
  })

  it("rejects unexpected and repeated arguments per subcommand", () => {
    expect(script).toContain("unexpected argument for this subcommand")
    expect(script).toContain("a flag was given twice")
    expect(script).toMatch(/status\) ALLOWED_FLAGS=" "/)
    expect(script).toMatch(/rollback\) ALLOWED_FLAGS=" --sha "/)
  })

  it("verifies root ownership and permissions of the deployment configuration", () => {
    const layout = script.slice(script.indexOf("check_layout() {"), script.indexOf("check_compose_hashes() {"))
    expect(layout).toContain("is not owned by root")
    expect(layout).toContain("$APP_DIR is not a root-owned directory")
    expect(layout).toContain("8#027")
    expect(script).toContain("not root-owned and protected")
  })

  it("inspects the database read-only and never mutates it", () => {
    expect(script).toContain("PGOPTIONS='-c default_transaction_read_only=on'")
    expect(scriptCode).not.toMatch(/docker compose[^\n]* down|volume (rm|prune)|system prune|--volumes|\bDROP\b|\bTRUNCATE\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/)
  })

  it("validates effective Compose ports and the running containers' bindings", () => {
    expect(script).toContain("config_port_violations")
    expect(script).toContain("check_ports_config")
    expect(script).toContain("runtime_port_violations")
    expect(script).toContain("health.ports_loopback")
    const pre = script.slice(script.indexOf("preflight_checks() {"), script.indexOf("cmd_preflight() {"))
    expect(pre.indexOf("check_ports_config")).toBeGreaterThan(pre.indexOf("check_compose_hashes"))
  })

  it("never runs git and never touches the server checkout or .env.docker", () => {
    expect(scriptCode).not.toMatch(/(^|[^A-Za-z_-])git( |$)/m)
    expect(scriptCode).not.toMatch(/>\s*"?\$ENV_FILE|>\s*"?\$COMPOSE_(BASE|PROD)|sed -i|\bmv\b[^\n]*\$(ENV_FILE|COMPOSE)/)
  })
})

describe("sudoers and forced command", () => {
  const rules = sudoers.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n")

  it("grants exactly the four approved subcommands of one program", () => {
    const granted = [...rules.matchAll(/\/usr\/local\/sbin\/cartoona-deploy ([^,\\\n]+)/g)].map((m) => m[1].trim())
    expect(granted).toEqual(["status", "preflight *", "deploy *", "rollback --sha *"])
  })

  it("grants nothing broader", () => {
    expect(rules).not.toMatch(/NOPASSWD:\s*ALL/)
    expect(rules).not.toMatch(/\bdocker\b|\/bin\/(ba)?sh|\bSETENV\b|\bALL\s*$/m)
    expect(rules).not.toMatch(/cartoona-deploy\s*(,|\\|$)/m)
    expect(rules).toContain("env_reset")
  })

  it("the forced command refuses empty and multi-line commands and never evaluates input", () => {
    expect(wrapper).toContain("$'\\n'")
    expect(wrapper).toContain("set -euf")
    expect(wrapper).not.toMatch(/\beval\b|\bbash -c\b|\bsh -c\b/)
    expect(wrapper).toContain('read -r -a args <<< "$SSH_ORIGINAL_COMMAND"')
  })
})

describe("the deploy workflow passes the release to every rollback", () => {
  it("both rollback invocations carry --sha, and none is bare", () => {
    const calls = [...workflow.matchAll(/cartoona-prod rollback([^\n>|]*)/g)].map((m) => m[1].trim())
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c).toContain('--sha "$RELEASE_SHA"')
  })

  it("a manual rollback must name the release", () => {
    expect(workflow).toMatch(/rollback needs release_sha/)
  })
})

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { loadEnvConfig } from "@next/env"
import { assertSafeDatabaseTarget } from "@/tests/helpers/assert-safe-database-target"
import { loadTestEnv, parseEnvFile } from "@/tests/helpers/load-test-env"

// ─────────────────────────────────────────────────────────────────────────────
// Environment resolution for stateful tests.
//
// Root cause being pinned: .env.local carried two Supabase blocks. Next.js
// (dotenv) resolves a repeated key to its LAST value, the old test loader to
// its FIRST, and ~20 inline spec loaders overwrote the caller's environment.
// The app and the safety guard could therefore name different projects.
// These tests keep (a) the guard strict and explicit, (b) the loader identical
// to Next.js and loud on ambiguity, (c) both agreeing on this checkout.
// Only refs and variable NAMES appear below - never a real key.
// ─────────────────────────────────────────────────────────────────────────────

const PROD = "oucyhmrnzahlhqjfqcge"
const DISPOSABLE = "bkctpxclggiqfllbjbre"
const OTHER = "xyzzzzzzzzzzzzzzzzzz"
const url = (ref: string) => `https://${ref}.supabase.co`

const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_PROJECT_REF",
  "CARTOONA_TEST_SUPABASE_URL",
  "CARTOONA_TEST_SUPABASE_PROJECT_REF",
  "CARTOONA_ALLOW_DESTRUCTIVE_TESTS",
]
let backup: Record<string, string | undefined> = {}
beforeEach(() => {
  backup = {}
  for (const k of [...KEYS, "NODE_ENV"]) backup[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(backup)) {
    if (v === undefined) delete process.env[k]
    else (process.env as Record<string, string>)[k] = v
  }
})

/** The complete, explicit disposable configuration. Tests override pieces. */
function setEnv(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: url(DISPOSABLE),
    CARTOONA_TEST_SUPABASE_URL: url(DISPOSABLE),
    CARTOONA_TEST_SUPABASE_PROJECT_REF: DISPOSABLE,
    SUPABASE_PROJECT_REF: DISPOSABLE,
    CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true",
  }
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe("guard: explicit stateful target", () => {
  test("1. explicit disposable target passes", () => {
    setEnv()
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(true)
    expect(r.kind).toBe("explicit_disposable")
  })

  test("2. production target fails (all identifiers production)", () => {
    setEnv({
      NEXT_PUBLIC_SUPABASE_URL: url(PROD),
      CARTOONA_TEST_SUPABASE_URL: url(PROD),
      CARTOONA_TEST_SUPABASE_PROJECT_REF: PROD,
      SUPABASE_PROJECT_REF: PROD,
    })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.kind).toBe("main")
  })

  test("3. disposable URL + production ref fails", () => {
    setEnv({ CARTOONA_TEST_SUPABASE_PROJECT_REF: PROD, SUPABASE_PROJECT_REF: undefined })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.kind).toBe("main")
  })

  test("4. production URL + disposable ref fails", () => {
    setEnv({
      NEXT_PUBLIC_SUPABASE_URL: url(PROD),
      CARTOONA_TEST_SUPABASE_URL: url(PROD),
    })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.kind).toBe("main")
  })

  test("4b. a production URL anywhere wins over an otherwise valid disposable config", () => {
    setEnv({ SUPABASE_URL: url(PROD) })
    expect(assertSafeDatabaseTarget().kind).toBe("main")
  })

  test("5. missing test ref fails", () => {
    setEnv({ CARTOONA_TEST_SUPABASE_PROJECT_REF: undefined, SUPABASE_PROJECT_REF: undefined })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/CARTOONA_TEST_SUPABASE_PROJECT_REF/)
  })

  test("6. missing test URL fails", () => {
    setEnv({ CARTOONA_TEST_SUPABASE_URL: undefined })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/CARTOONA_TEST_SUPABASE_URL/)
  })

  test("7. generic NEXT_PUBLIC values alone never authorize a hosted run", () => {
    for (const env of [
      { NEXT_PUBLIC_SUPABASE_URL: url(DISPOSABLE) },
      { NEXT_PUBLIC_SUPABASE_URL: url(DISPOSABLE), SUPABASE_URL: url(DISPOSABLE) },
      // even with a matching ref and the opt-in flag
      { NEXT_PUBLIC_SUPABASE_URL: url(DISPOSABLE), SUPABASE_PROJECT_REF: DISPOSABLE, CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true" },
      // and a test ref without a test URL
      { NEXT_PUBLIC_SUPABASE_URL: url(DISPOSABLE), CARTOONA_TEST_SUPABASE_PROJECT_REF: DISPOSABLE, CARTOONA_ALLOW_DESTRUCTIVE_TESTS: "true" },
    ]) {
      for (const k of KEYS) delete process.env[k]
      Object.assign(process.env, env)
      const r = assertSafeDatabaseTarget()
      expect(r.ok).toBe(false)
      expect(r.kind).toBe("unknown")
    }
  })

  test("8. local-only target still valid, and needs the opt-in", () => {
    for (const k of KEYS) delete process.env[k]
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321"
    process.env.SUPABASE_URL = "http://127.0.0.1:54321"
    expect(assertSafeDatabaseTarget().ok).toBe(false)
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(true)
    expect(r.kind).toBe("local")
  })

  test("8b. bracketed IPv6 loopback is recognised as local (was silently dropped)", () => {
    for (const k of KEYS) delete process.env[k]
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://[::1]:54321"
    process.env.CARTOONA_ALLOW_DESTRUCTIVE_TESTS = "true"
    expect(assertSafeDatabaseTarget().kind).toBe("local")
  })

  test("8c. local runtime URL with a hosted test target is a mixed configuration", () => {
    setEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/disagree/)
  })

  test("9. conflicting identifiers fail (runtime vs test, test URL vs ref, two refs)", () => {
    for (const over of [
      { NEXT_PUBLIC_SUPABASE_URL: url(OTHER) }, // runtime points elsewhere
      { SUPABASE_URL: url(OTHER) },
      { CARTOONA_TEST_SUPABASE_URL: url(OTHER) }, // test URL disagrees with test ref
      { SUPABASE_PROJECT_REF: OTHER },
    ]) {
      setEnv(over)
      const r = assertSafeDatabaseTarget()
      expect(r.ok, JSON.stringify(Object.keys(over))).toBe(false)
      expect(r.kind).toBe("unknown")
    }
  })

  test("9b. a malformed URL is never dropped in favour of a valid sibling", () => {
    setEnv({ SUPABASE_URL: "not-a-url" })
    expect(assertSafeDatabaseTarget().ok).toBe(false)
    setEnv({ NEXT_PUBLIC_SUPABASE_URL: `${url(DISPOSABLE)}/rest/v1` })
    expect(assertSafeDatabaseTarget().ok).toBe(false)
  })

  test("10. equivalent identifiers normalize safely", () => {
    setEnv({
      NEXT_PUBLIC_SUPABASE_URL: `  ${url(DISPOSABLE)}/  `,
      SUPABASE_URL: `HTTPS://${DISPOSABLE.toUpperCase()}.SUPABASE.CO`,
      CARTOONA_TEST_SUPABASE_URL: `${url(DISPOSABLE)}`,
      CARTOONA_TEST_SUPABASE_PROJECT_REF: ` ${DISPOSABLE.toUpperCase()} `,
      SUPABASE_PROJECT_REF: DISPOSABLE,
    })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(true)
    expect(r.kind).toBe("explicit_disposable")
  })

  test("10b. an upper-case production ref is still production", () => {
    setEnv({ CARTOONA_TEST_SUPABASE_PROJECT_REF: PROD.toUpperCase() })
    expect(assertSafeDatabaseTarget().ok).toBe(false)
  })

  test("10c. the opt-in flag is still required", () => {
    setEnv({ CARTOONA_ALLOW_DESTRUCTIVE_TESTS: undefined })
    const r = assertSafeDatabaseTarget()
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/CARTOONA_ALLOW_DESTRUCTIVE_TESTS/)
  })
})

describe("loader: identical to Next.js, loud on ambiguity", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartoona-env-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (content: string) => {
    const file = path.join(dir, ".env.local")
    fs.writeFileSync(file, content)
    return file
  }

  test("a repeated key resolves to its LAST value, like dotenv/Next", () => {
    const parsed = parseEnvFile("A=1\nA=2\n")
    expect(parsed.values.A).toBe("2")
  })

  test("the real environment wins over the file", () => {
    const file = write(`NEXT_PUBLIC_SUPABASE_URL=${url(PROD)}\n`)
    const env: NodeJS.ProcessEnv = { NEXT_PUBLIC_SUPABASE_URL: url(DISPOSABLE) }
    loadTestEnv({ file, env })
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(url(DISPOSABLE))
  })

  test("the file only fills what is missing", () => {
    const file = write(`NEXT_PUBLIC_SUPABASE_URL=${url(DISPOSABLE)}\nOTHER=x\n`)
    const env: NodeJS.ProcessEnv = { OTHER: "kept", EMPTY: "" }
    loadTestEnv({ file, env })
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(url(DISPOSABLE))
    expect(env.OTHER).toBe("kept")
  })

  test("the original bug file (production block, then disposable block) is refused", () => {
    const file = write(
      [
        `NEXT_PUBLIC_SUPABASE_URL=${url(PROD)}`,
        "SUPABASE_SECRET_KEY=prod-secret-value",
        `NEXT_PUBLIC_SUPABASE_URL=${url(DISPOSABLE)}`,
        "SUPABASE_SECRET_KEY=disposable-secret-value",
      ].join("\n"),
    )
    const env: NodeJS.ProcessEnv = {}
    expect(() => loadTestEnv({ file, env })).toThrow(/Ambiguous environment file/)
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined() // nothing was applied
  })

  test("the refusal names keys only and never leaks a value", () => {
    const file = write("SUPABASE_SECRET_KEY=prod-secret-value\nSUPABASE_SECRET_KEY=disposable-secret-value\n")
    let message = ""
    try {
      loadTestEnv({ file, env: {} })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("SUPABASE_SECRET_KEY")
    expect(message).not.toMatch(/secret-value/)
  })

  test("a repeated key that agrees with itself is harmless", () => {
    const file = write(`NEXT_PUBLIC_SUPABASE_URL=${url(DISPOSABLE)}\nNEXT_PUBLIC_SUPABASE_URL=${url(DISPOSABLE)}\n`)
    const env: NodeJS.ProcessEnv = {}
    expect(() => loadTestEnv({ file, env })).not.toThrow()
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(url(DISPOSABLE))
  })

  test("unrelated repeated keys keep Next's last-wins and do not block the run", () => {
    const file = write("SOMETHING_ELSE=a\nSOMETHING_ELSE=b\n")
    const env: NodeJS.ProcessEnv = {}
    loadTestEnv({ file, env })
    expect(env.SOMETHING_ELSE).toBe("b")
  })

  test("quotes, export prefix and trailing comments parse like Next", () => {
    const parsed = parseEnvFile(
      ['export A="quoted value"', "B=plain # comment", "C='single'", "D=https://x.supabase.co", "# skipped", ""].join("\n"),
    )
    expect(parsed.values).toEqual({ A: "quoted value", B: "plain", C: "single", D: "https://x.supabase.co" })
  })

  test("a missing file is a no-op", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(() => loadTestEnv({ file: path.join(dir, "absent"), env })).not.toThrow()
    expect(env).toEqual({})
  })
})

describe("Next.js and the stateful-test loader resolve the same project", () => {
  const snapshot = () => ({ ...process.env })
  function restore(s: NodeJS.ProcessEnv) {
    for (const k of Object.keys(process.env)) if (!(k in s)) delete process.env[k]
    Object.assign(process.env, s)
  }
  const refOf = (v: string | undefined) => (v ? new URL(v).hostname.split(".")[0] : null)

  /** What `next dev` would resolve from `dir`. */
  function nextResolves(dir: string): NodeJS.ProcessEnv {
    const before = snapshot()
    try {
      for (const k of Object.keys(process.env)) {
        if (/SUPABASE|CARTOONA_/.test(k)) delete process.env[k]
      }
      ;(process.env as Record<string, string>).NODE_ENV = "development" // vitest sets "test", where Next skips .env.local
      loadEnvConfig(dir, true, console, true)
      return snapshot()
    } finally {
      restore(before)
    }
  }
  /** What the test loader resolves from the same file. */
  function testHelperResolves(dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    loadTestEnv({ file: path.join(dir, ".env.local"), env })
    return env
  }

  test("single-block file: identical runtime and test refs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartoona-env-"))
    try {
      fs.writeFileSync(
        path.join(dir, ".env.local"),
        [
          `NEXT_PUBLIC_SUPABASE_URL=${url(DISPOSABLE)}`,
          `CARTOONA_TEST_SUPABASE_URL=${url(DISPOSABLE)}`,
          `CARTOONA_TEST_SUPABASE_PROJECT_REF=${DISPOSABLE}`,
        ].join("\n"),
      )
      const next = nextResolves(dir)
      const helper = testHelperResolves(dir)
      expect(refOf(next.NEXT_PUBLIC_SUPABASE_URL)).toBe(DISPOSABLE)
      expect(refOf(helper.NEXT_PUBLIC_SUPABASE_URL)).toBe(refOf(next.NEXT_PUBLIC_SUPABASE_URL))
      expect(helper.CARTOONA_TEST_SUPABASE_PROJECT_REF).toBe(next.CARTOONA_TEST_SUPABASE_PROJECT_REF)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the old ambiguity: Next resolves the later block, the helper now refuses instead of guessing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartoona-env-"))
    try {
      fs.writeFileSync(
        path.join(dir, ".env.local"),
        `NEXT_PUBLIC_SUPABASE_URL=${url(PROD)}\nNEXT_PUBLIC_SUPABASE_URL=${url(DISPOSABLE)}\n`,
      )
      expect(refOf(nextResolves(dir).NEXT_PUBLIC_SUPABASE_URL)).toBe(DISPOSABLE) // last wins in Next
      expect(() => testHelperResolves(dir)).toThrow(/Ambiguous environment file/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const realFile = path.resolve(__dirname, "../../.env.local")
  test.skipIf(!fs.existsSync(realFile))("this checkout's .env.local: Next, the helper and the guard agree on one project", () => {
    const root = path.resolve(__dirname, "../..")
    const next = nextResolves(root)
    const helper = testHelperResolves(root) // throws if the file is ambiguous

    const runtimeRef = refOf(next.NEXT_PUBLIC_SUPABASE_URL)
    expect(runtimeRef).not.toBeNull()
    expect(refOf(helper.NEXT_PUBLIC_SUPABASE_URL)).toBe(runtimeRef)
    expect(refOf(helper.CARTOONA_TEST_SUPABASE_URL)).toBe(runtimeRef)
    expect(helper.CARTOONA_TEST_SUPABASE_PROJECT_REF?.trim().toLowerCase()).toBe(runtimeRef)
    expect(runtimeRef).not.toBe(PROD)

    // And the guard, fed exactly what the helper resolved, accepts it.
    for (const k of KEYS) delete process.env[k]
    for (const k of KEYS) if (helper[k] !== undefined) process.env[k] = helper[k]
    const verdict = assertSafeDatabaseTarget()
    expect(verdict.ok, verdict.reason).toBe(true)
    expect(verdict.kind).toBe("explicit_disposable")
  })
})

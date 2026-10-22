import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Static guards for the V0.1.47 write-security foundation: v3 for every
 * backend write, nonce consumption only on the write path, the proof write's
 * shape, and that no Next.js write has been cut over yet.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

function walk(dir: string, pattern = /\.(ts|tsx|js|jsx|mjs)$/): string[] {
  if (!fs.existsSync(path.join(root, dir))) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel, pattern))
    else if (pattern.test(entry.name)) out.push(rel)
  }
  return out
}

const frontendFiles = [...walk("app"), ...walk("components"), ...walk("lib"), "middleware.ts"]
const backendRoutes = walk("backend/src/routes")

describe("assertion versions", () => {
  const src = code("lib/identity/assertion.ts")

  it("v3 carries a nonce and a body digest; v2 does not", () => {
    expect(src).toMatch(/2: \["aat", "exp", "iat", "mth", "prv", "pth", "rid", "sub", "v"\],/)
    expect(src).toMatch(/3: \["aat", "bdg", "exp", "iat", "mth", "nce", "prv", "pth", "rid", "sub", "v"\],/)
    expect(src).toMatch(/nce: nonce, bdg: bodyDigest\(input\.body\)/)
  })

  it("v2 is signed only for GET/HEAD, v3 only for POST/PUT/PATCH/DELETE, with separate MAC contexts", () => {
    expect(src).toMatch(/const READ_METHODS = new Set\(\["GET", "HEAD"\]\)/)
    expect(src).toMatch(/const WRITE_METHODS = new Set\(\["POST", "PUT", "PATCH", "DELETE"\]\)/)
    expect(src).toMatch(/encode\(2, \{ v: ASSERTION_VERSION, \.\.\.baseClaims\(input, READ_METHODS\) \}/)
    expect(src).toMatch(/v: WRITE_ASSERTION_VERSION, \.\.\.baseClaims\(input, WRITE_METHODS\)/)
    expect(src).toMatch(/2: "cartoona-internal-auth\\nv2\\n", 3: "cartoona-internal-auth\\nv3\\n"/)
  })

  it("verification picks the version from the expected kind, never from the token", () => {
    expect(src).toMatch(/const wanted: 2 \| 3 = kind === "write" \? 3 : 2/)
    expect(src).toMatch(/if \(version !== `v\$\{wanted\}`\) return fail\("unsupported_version"\)/)
    expect(src).toMatch(/const methods = kind === "write" \? WRITE_METHODS : READ_METHODS/)
  })

  it("the body digest is compared in constant time over the received bytes", () => {
    expect(src).toMatch(/Buffer\.from\(bodyDigest\(input\.body\), "base64url"\)/)
    expect(src).toMatch(/timingSafeEqual\(received, signed\)/)
  })
})

describe("Fastify: writes go through requireWriteAuth, reads cannot consume a nonce", () => {
  const auth = code("backend/src/plugins/auth.ts")

  it("requireAuth verifies as a read; requireWriteAuth as a write with the received body", () => {
    const read = auth.slice(auth.indexOf("export function requireAuth("), auth.indexOf("export function requireWriteAuth("))
    expect(read).toMatch(/authenticate\(request, reply, deps, "read"\)/)
    expect(read).not.toMatch(/consumeWriteNonce|"write"/)
    const write = auth.slice(auth.indexOf("export function requireWriteAuth("))
    expect(write).toMatch(/authenticate\(request, reply, deps, "write"\)/)
    expect(auth).toMatch(/body: request\.rawBody \?\? Buffer\.alloc\(0\)/)
  })

  it("requireWriteAuth checks the role, THEN consumes the nonce, THEN sets the principal", () => {
    const write = auth.slice(auth.indexOf("export function requireWriteAuth("))
    const role = write.indexOf("roles.includes(verified.principal.role)")
    const nonce = write.indexOf("consumeWriteNonce(")
    const principal = write.indexOf("request.authPrincipal = verified.principal")
    expect(role).toBeGreaterThan(0)
    expect(nonce).toBeGreaterThan(role)
    expect(principal).toBeGreaterThan(nonce)
    expect(write).toMatch(/if \(!consumed\) return reject\(request, reply, 409, "replayed_request", "NONCE_REPLAYED"\)/)
  })

  it("the nonce repository is used only by requireWriteAuth", () => {
    const users = [...walk("backend"), ...frontendFiles].filter((f) => !f.includes("/dist/") && code(f).includes("repositories/write-nonces"))
    expect(users).toEqual(["backend/src/plugins/auth.ts"])
  })

  it("every non-GET backend route uses requireWriteAuth with an explicit role, and nothing else", () => {
    const writes: string[] = []
    for (const file of backendRoutes) {
      for (const m of code(file).matchAll(/app\.(post|put|patch|delete)\(\s*([A-Z_]+|"[^"]+"),\s*\{ preHandler: \[([^\]]*)\] \}/g)) {
        writes.push(`${m[1]} ${m[2]}`)
        expect(m[3], file).toMatch(/^requireWriteAuth\(deps, "(parent|admin|super_admin)"(, "(parent|admin|super_admin)")*\)$/)
      }
    }
    // No write registered any other way (route(), or a write without that preHandler).
    const anyWrite = backendRoutes.flatMap((f) => code(f).match(/app\.(post|put|patch|delete|route)\(/g) ?? [])
    expect(anyWrite).toHaveLength(writes.length)
    // V0.1.47 proof write + V0.1.48 consent (the first product write).
    expect(writes.sort()).toEqual(["patch PROFILE_PATH", "post CONSENT_PATH"])
  })

  it("the raw JSON bytes are kept for the digest, parsed by Fastify's safe default parser", () => {
    const app = code("backend/src/app.ts")
    expect(app).toMatch(/app\.getDefaultJsonParser\("error", "error"\)/)
    expect(app).toMatch(/addContentTypeParser\("application\/json", \{ parseAs: "buffer" \}/)
    expect(app).toMatch(/request\.rawBody = body as Buffer/)
  })
})

describe("the proof write PATCH /v1/parent/profile", () => {
  const route = code("backend/src/routes/parent-account.ts")
  const write = route.slice(route.indexOf("function registerProfileWrite("), route.indexOf("async function handle("))

  it("takes the user only from the principal and accepts exactly one body key", () => {
    expect(write).toMatch(/updateParentProfileName\(deps\.db\(\), \{ userId: request\.authPrincipal!\.userId, fullName: name\.value \}\)/)
    expect(write).toMatch(/if \(keys\.length !== 1 \|\| keys\[0\] !== "fullName"\) return invalid\("keys"\)/)
    expect(write).not.toMatch(/request\.(headers|cookies|params)|x-user-id|x-role|parentProfileId|body\.userId/i)
    expect(write).toMatch(/Cache-Control", "no-store"/)
    expect(write).toMatch(/checkParentName\(/)
  })

  it("the name rules are a neutral module (no server, Node or database import)", () => {
    expect(code("lib/parent/profile-name.ts")).not.toMatch(/^import /m)
  })
})

describe("exactly one Next.js write is cut over: consent (V0.1.48)", () => {
  it("backendWriteJson has exactly one caller outside the client module: the consent loader", () => {
    const callers = frontendFiles.filter((f) => f !== "lib/backend/client.ts" && /backendWriteJson/.test(code(f)))
    expect(callers).toEqual(["lib/parent/consent/backend-consent.ts"])
  })

  it("no other Next write handler imports the backend client, the parent backend caller or the consent writer", () => {
    const handlers = walk("app/api").filter((f) => /export (const|async function|function) (POST|PUT|PATCH|DELETE)\b/.test(read(f)))
    expect(handlers.length).toBeGreaterThan(15)
    const writers = handlers.filter((f) => /@\/lib\/backend\/client|@\/lib\/parent\/backend-caller|signWriteAssertion|grantParentConsent/.test(code(f)))
    expect(writers).toEqual(["app/api/parent-consent/route.ts"])
  })

  it("the browser never signs: assertion signing stays in server-only modules", () => {
    // assertion.ts defines the signers; client.ts (server-only) is the only caller.
    const signers = frontendFiles.filter((f) => /signWriteAssertion|signAssertion\(/.test(code(f)))
    expect(signers.sort()).toEqual(["lib/backend/client.ts", "lib/identity/assertion.ts"])
    expect(read("lib/backend/client.ts")).toMatch(/^import "server-only"/m)
  })

  it("no frontend file imports pg, lib/db or any repository (including the write ones)", () => {
    for (const f of [...walk("app"), ...walk("components"), "middleware.ts"]) {
      expect(code(f), f).not.toMatch(/from "pg"|@\/lib\/db\/|@\/lib\/repositories\//)
    }
  })
})

describe("database grants for the write path", () => {
  const nonce = read("database/migrations/0012_internal_write_nonces.sql").replace(/--.*$/gm, "")
  const name = read("database/migrations/0013_parent_profile_name_update_grant.sql").replace(/--.*$/gm, "")

  it("0012: EXECUTE on the one function, nothing on the table; definer with an empty search_path", () => {
    expect(nonce).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/)
    expect(nonce).toMatch(/REVOKE ALL ON TABLE public\.internal_write_nonces FROM PUBLIC;/)
    expect(nonce).toMatch(/REVOKE ALL ON FUNCTION public\.consume_internal_write_nonce\(text, timestamp with time zone, text\) FROM PUBLIC;/)
    expect(nonce).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*internal_write_nonces/i)
    expect(nonce).toMatch(/ON CONFLICT \(nonce\) DO NOTHING/)
    expect(nonce).not.toMatch(/user_id|provider_subject/)
  })

  it("0013: UPDATE on full_name and updated_at only", () => {
    expect(name.trim()).toBe("GRANT UPDATE (full_name, updated_at) ON public.parent_profiles TO cartoona_app;")
  })
})

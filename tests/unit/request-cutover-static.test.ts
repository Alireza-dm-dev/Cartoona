import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * Static guards for the V0.1.50 request-submission cutover: the request write
 * is ONE PostgreSQL function behind a v3-authenticated, parent-only Fastify
 * route; the browser cannot choose actor, profile, wallet, price or status;
 * Supabase keeps Auth, Storage and the (read-only) gallery metadata; money
 * paths that did not move still go to Supabase.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "")
const sqlCode = (p: string) => read(p).replace(/--.*$/gm, "")

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

const ROUTE = "app/api/requests/route.ts"
const LOOKUP_ROUTE = "app/api/requests/by-submission-key/route.ts"
const BACKEND_ROUTE = "backend/src/routes/parent-requests.ts"
const REPO = "lib/repositories/parent-requests.ts"

describe("POST /api/requests has no Supabase Database/RPC business access", () => {
  const route = code(ROUTE)

  it("no .rpc(, no admin client, no Supabase table, no create_parent_request_trusted name", () => {
    expect(route).not.toMatch(/\.rpc\(|createAdminSupabaseClient|supabase\/admin|create_parent_request_trusted/)
    // The only .from( is Storage: supabase.storage.from("parent-uploads" | bucket).
    for (const m of route.matchAll(/\.from\(/g)) {
      expect(route.slice(Math.max(0, m.index! - 24), m.index!), "a table read").toMatch(/storage\s*$/)
    }
    expect(route).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })

  it("identity, consent, role and the profile come from the backend; the Supabase user/role/profile queries are gone", () => {
    expect(route).toMatch(/verifyParentCaller\(\)/)
    expect(route).toMatch(/fetchParentConsent\(context\)/)
    expect(route).toMatch(/createRequestViaBackend\(context, payload\)/)
    expect(route).not.toMatch(/auth\.getUser|"users"|"parent_profiles"|checkParentSessionLifetime|loadParentConsent|resolveCharacterId/)
    // The storage key uses the VERIFIED subject, never a browser value.
    expect(route).toMatch(/storagePath = `\$\{subject\}\/\$\{orderId\}\//)
    expect(route).toMatch(/const subject = context\.identity\.subject/)
  })

  it("CSRF first (multipart variant), then everything else", () => {
    const body = route.slice(route.indexOf("async function handlePost("))
    expect(body.indexOf("rejectUnsafeBrowserWrite(request, process.env, \"multipart\")")).toBeGreaterThan(-1)
    expect(body.indexOf("rejectUnsafeBrowserWrite")).toBeLessThan(body.indexOf("verifyParentCaller"))
    expect(body.indexOf("verifyParentCaller")).toBeLessThan(body.indexOf("enforceRateLimit"))
    expect(body.indexOf("enforceRateLimit")).toBeLessThan(body.indexOf("fetchParentConsent"))
    expect(body.indexOf("fetchParentConsent")).toBeLessThan(body.indexOf("request.formData()"))
    expect(body.indexOf("lookupRequestBySubmissionKey")).toBeLessThan(body.indexOf("storage"))
  })

  it("an uncertain outcome never removes the upload; only definite refusals and race losers do", () => {
    expect(code(ROUTE)).toMatch(/case "outcome_unknown":\s*return NextResponse\.json\(/)
    expect(code(ROUTE)).toMatch(/case "not_created":\s*return NextResponse\.json\(/)
    const unknown = route.slice(route.indexOf('case "outcome_unknown"'), route.indexOf('case "refused"'))
    expect(unknown).not.toMatch(/removeOrphanedUpload|cleanupRefused/)
    expect(route).toMatch(/if \(order\.orderId !== orderId\) \{\s*await cleanupRefused\("replay_lost_race"\)/)
  })

  it("the uncertain answer is the Persian 'could not confirm' text, never 'failed'", () => {
    expect(read(ROUTE)).toContain('const OUTCOME_UNKNOWN_MESSAGE = "نتوانستیم تأیید کنیم که درخواست ثبت شده است یا نه."')
  })

  it("Storage stays Supabase (bytes are not migrated) and is the ONLY remaining Supabase dependency besides Auth (V0.1.52: the gallery source is resolved in PostgreSQL too)", () => {
    expect(route).toMatch(/supabase\.storage\s*\.from\("parent-uploads"\)/)
    expect(route).toMatch(/resolveOwnedSourceAsset\(context, sourceAssetId\)/)
    const supabaseImports = [...read(ROUTE).matchAll(/from "(@\/lib\/supabase\/[a-z-]+)"/g)].map((m) => m[1])
    expect(supabaseImports).toEqual(["@/lib/supabase/server"])
  })
})

describe("the recovery routes", () => {
  it("the Next lookup is a GET with exactly one UUID query key, verifies the caller, writes nothing, takes no actor id", () => {
    const r = code(LOOKUP_ROUTE)
    expect(r).toMatch(/export const GET = withObservability/)
    expect(r).not.toMatch(/export const (POST|PUT|PATCH|DELETE)/)
    expect(r).toMatch(/names\.length !== 1 \|\| names\[0\] !== "submissionKey"/)
    expect(r).toMatch(/verifyParentCaller\(\)/)
    expect(r).not.toMatch(/parentProfileId|userId|\.rpc\(|\.from\(|createServerSupabaseClient/)
  })

  it("the Fastify lookup is a v2 READ route (requireAuth + parent role), keyed by the profile from the assertion", () => {
    const r = code(BACKEND_ROUTE)
    expect(r).toMatch(/app\.get\(REQUEST_BY_KEY_PATH, \{ preHandler: \[requireAuth\(deps\), requireRole\("parent"\)\] \}/)
    expect(r).toMatch(/findParentProfileIdByUserId\(db, \{ userId: request\.authPrincipal!\.userId \}\)/)
    expect(r).toMatch(/findRequestBySubmissionKey\(db, \{ parentProfileId, submissionKey: key \}\)/)
  })
})

describe("the Fastify write route", () => {
  const r = code(BACKEND_ROUTE)

  it("is v3 (body digest + nonce) and parent-only, with no other way to authenticate", () => {
    expect(r).toMatch(/\{ bodyLimit: POST_BODY_LIMIT, preHandler: \[requireWriteAuth\(deps, "parent"\)\] \}/)
    expect(r).not.toMatch(/requireAuth\(deps\), requireWriteAuth|requireProvisioningAuth/)
  })

  it("takes the actor ONLY from the principal; no header, cookie, param or body field names a user, profile, wallet or price", () => {
    expect(r).toMatch(/const userId = request\.authPrincipal!\.userId/)
    expect(r).not.toMatch(/request\.(headers|cookies|params)|x-user-id|x-role|x-parent/i)
    const keys = r.match(/const BODY_KEYS = new Set\(\[([\s\S]*?)\]\)/)![1].match(/"[a-zA-Z]+"/g)!.map((k) => k.replace(/"/g, ""))
    expect(keys.sort()).toEqual([
      "animationStyle", "character", "charactersSpeak", "childName", "description", "durationChoice", "durationKey", "file",
      "orderId", "submissionKey", "title", "type", "videoScript", "videoStyle",
    ].sort())
    for (const forbidden of ["userId", "parentProfileId", "parentId", "role", "price", "candyCost", "creditAmount", "balance", "walletId", "status", "paymentSource"]) {
      expect(keys, forbidden).not.toContain(forbidden)
    }
    expect(r).toMatch(/keys\.length !== BODY_KEYS\.size \|\| keys\.some\(\(k\) => !BODY_KEYS\.has\(k\)\)/)
  })

  it("the file key must sit in the CALLER's own folder, and the route is one DB operation after the profile lookup", () => {
    expect(r).toMatch(/f\.path\.startsWith\(`\$\{userId\}\//)
    expect(r).toMatch(/createParentRequest\(db, \{ \.\.\.parsed\.input, parentProfileId, characterId \}\)/)
    expect(r).not.toMatch(/BEGIN|COMMIT|\.connect\(|transaction/i)
  })

  it("never exposes database text: only the mapped safe token, always no-store", () => {
    expect(r).toMatch(/mapRequestRpcError\(error\.businessCode\)/)
    expect(r).toMatch(/reply\.code\(mapped\.status\)\.send\(\{ error: mapped\.code \}\)/)
    expect(r).not.toMatch(/error\.message|error\.cause|\.detail|\.hint/)
    expect(r.match(/reply\.header\("Cache-Control", "no-store"\)/g)).toHaveLength(2)
  })

  it("contains no purchase, coupon, media, Storage or Supabase code", () => {
    expect(r).not.toMatch(/candy_purchases|payment_attempts|coupon|record_final_media|storage\.|supabase|\.rpc\(/i)
  })
})

describe("the repository: the request function is the ONLY write capability", () => {
  const repo = code(REPO)

  it("executes create_parent_request_trusted and contains no INSERT/UPDATE/DELETE statement", () => {
    expect(repo).toMatch(/FROM public\.create_parent_request_trusted\(/)
    expect(repo).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|TRUNCATE)\b/i)
  })

  it("reads orders only by (parent_id, submission_key) and characters by name; takes no wallet, price or balance", () => {
    expect(repo).toMatch(/WHERE o\.parent_id = \$1 AND o\.submission_key = \$2/)
    expect(repo).not.toMatch(/candy_wallets|parent_welcome_credits|creation_pricing/)
  })

  it("only the backend route imports the repository's write", () => {
    const users = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("backend/src")]
      .filter((f) => f !== REPO && /repositories\/parent-requests/.test(read(f)))
    expect(users).toEqual([BACKEND_ROUTE])
  })

  it("no application code outside the repository names the request function (the Supabase RPC is not called anywhere)", () => {
    const names = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("backend/src"), ...walk("scripts")]
      .filter((f) => f !== REPO && /create_parent_request_trusted/.test(code(f)))
    expect(names).toEqual([])
  })
})

describe("the browser contract and the client", () => {
  it("the public request body is unchanged: draft, submissionKey, file | sourceAssetId only", () => {
    const client = code("lib/requests/submission-client.ts")
    expect([...client.matchAll(/formData\.set\("([a-zA-Z]+)"/g)].map((m) => m[1]).sort()).toEqual(["draft", "file", "sourceAssetId", "submissionKey"])
  })

  it("the page keeps the key in the persisted attempt store, never mints one outside beginAttempt, and sends users to the PostgreSQL-backed list", () => {
    const page = code("components/creation/complete-creation-request.tsx")
    expect(page).not.toMatch(/submissionKeyRef/)
    expect([...page.matchAll(/randomUUID/g)]).toHaveLength(0)
    expect(page).toMatch(/beginAttempt\(store\(\), draftHash, mintSubmissionKey, attemptRef\)/)
    expect(page).toMatch(/router\.push\("\/dashboard\/orders"\)/)
    expect(page).not.toMatch(/router\.push\(`\/dashboard\/orders\/\$\{/)
    expect(page).toMatch(/markUncertain\(store\(\), attempt, attemptRef\)/)
    expect(page).toMatch(/failureProvesNothingCreated\(res\.status, body\?\.code\)/)
  })

  it("the client never calls the backend, never signs, and the recovery check is a GET to the Next route", () => {
    for (const f of ["components/creation/complete-creation-request.tsx", "lib/requests/submission-client.ts", "lib/requests/submission-attempt.ts"]) {
      expect(code(f), f).not.toMatch(/:4000|\/v1\/|x-cartoona-internal-auth|signWriteAssertion|BACKEND_/)
    }
    expect(code("lib/requests/submission-client.ts")).toMatch(/\/api\/requests\/by-submission-key\?submissionKey=/)
  })
})

describe("scope: what did NOT move", () => {
  it("V0.1.51 moved purchases; the request route does not call purchase code, and purchases do not call request code", () => {
    for (const f of ["app/api/candy-purchases/route.ts", ...walk("app/api/coupons")]) {
      expect(code(f), f).not.toMatch(/createRequestViaBackend/)
    }
    expect(code(ROUTE)).not.toMatch(/candy-purchases|backend-purchases/)
  })

  it("V0.1.52 closed the V0.1.51 blocker: the order DETAIL page reads PostgreSQL through the backend loader", () => {
    expect(code("lib/parent/orders/detail-queries.ts")).not.toMatch(/SupabaseClient/)
    expect(code("app/(dashboard)/dashboard/orders/[orderId]/page.tsx")).toMatch(/backend-order-detail/)
  })

  it("migration 0016 changes no function body and adds no table, column or write privilege", () => {
    const sql = sqlCode("database/migrations/0016_parent_request_privileges.sql")
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+/i)
    expect([...sql.matchAll(/^\s*(GRANT|REVOKE)\s+([^;]+);/gim)].map((m) => `${m[1]} ${m[2].replace(/\s+/g, " ").split(" ON ")[0]}`)).toEqual(["REVOKE ALL", "GRANT EXECUTE", "GRANT SELECT"])
  })

  it("the Supabase request RPC migration of V0.1.48 is kept (history is not rewritten) and documented as transitional", () => {
    expect(fs.existsSync(path.join(root, "supabase/migrations/20261022100000_request_rpc_consent_gate_moved.sql"))).toBe(true)
    expect(read("docs/ROUTE_CUTOVER.md")).toMatch(/transitional/i)
  })
})

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * V0.1.52 static guards (no database): the migrated order/media/admin surfaces
 * read and write PostgreSQL through the backend only; Storage is bytes and
 * signing only; the browser can never name an object, an actor or a role.
 */

const root = process.cwd()
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}

const PARENT_SURFACES = [
  "lib/parent/orders/detail-queries.ts", "lib/parent/orders/backend-order-detail.ts", "lib/parent/backend-media.ts",
  "lib/parent/gallery/queries.ts", "lib/parent/gallery/source-asset.ts", "app/api/parent/gallery/route.ts",
  "app/api/parent/orders/[orderId]/final-media/route.ts", "app/(dashboard)/dashboard/orders/[orderId]/page.tsx",
  "app/(dashboard)/dashboard/gallery/page.tsx",
]
const ADMIN_SURFACES = [...walk("app/api/admin/requests"), ...walk("app/admin/requests"), ...walk("lib/admin/requests")]
const MIGRATED = [...PARENT_SURFACES, ...ADMIN_SURFACES, "lib/storage/final-deliverables.ts", "app/api/requests/route.ts"]

describe("19/20. no Supabase business read or write remains in the migrated surfaces", () => {
  it("no .from()/.rpc() against any business table or function", () => {
    for (const f of MIGRATED) {
      expect(code(f), f).not.toMatch(/\.from\(\s*["'`](?!parent-uploads|final-deliverables)[a-z_]+["'`]\s*\)|\.rpc\(/)
    }
  })

  it("the old Supabase-shaped readers and writers are gone", () => {
    for (const f of [
      "lib/parent/orders/final-media-queries.ts", "lib/audit/final-media-audit.ts", "lib/admin/requests/queries.ts",
      "lib/parent/parent-request-context.ts",
    ]) expect(fs.existsSync(path.join(root, f)), f).toBe(false)
    for (const f of [...walk("app"), ...walk("lib"), ...walk("components")]) {
      expect(code(f), f).not.toMatch(
        /getParentOrderDetail\b|resolveParentOwnsOrder|resolveCurrentParentFinalMedia|recordFinalMediaAudit|queryAdminRequestQueue|queryAdminRequestDetail|loadAdminFinalMedia|loadAdminFulfilmentHistory|updateOrderStatusViaTrustedRpc|recordFinalMediaViaTrustedRpc|approveFinalMediaViaTrustedRpc|supersedeFinalMediaViaTrustedRpc|resolveParentRequestContext|get_parent_order_status_history\b|get_order_status_history_admin\b[^_]/,
      )
    }
  })

  it("the service credential is used for Storage bytes only on these paths (one module), never for a table", () => {
    const users = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => /createAdminSupabaseClient/.test(code(f)) && !f.startsWith("lib/supabase/"))
    // Remaining, documented non-order users: the dev parent-auth route and the homepage CMS.
    expect(users.sort()).toEqual(["app/api/dev/parent-auth/route.ts", "lib/admin/homepage/media-service.ts", "lib/admin/homepage/service.ts", "lib/storage/final-deliverables.ts"])
    const storage = code("lib/storage/final-deliverables.ts")
    expect([...storage.matchAll(/admin\.(\w+)/g)].map((m) => m[1]).every((m) => m === "storage")).toBe(true)
    expect(storage).not.toMatch(/\.rpc\(|admin\.from\(/)
  })

  it("the backend never touches Storage, a provider SDK or a key it was not given by PostgreSQL", () => {
    for (const f of walk("backend/src")) expect(code(f), f).not.toMatch(/@supabase|storage\.from|createSignedUrl|final-deliverables|parent-uploads|createAdminSupabaseClient/)
  })
})

describe("8/15/16. no browser-supplied object key, bucket, actor or role", () => {
  it("signing happens only in the final-media route (after PostgreSQL authorization) and the admin view loader", () => {
    const signers = [...walk("app"), ...walk("lib")].filter((f) => /signFinalDeliverable\(/.test(code(f)) && f !== "lib/storage/final-deliverables.ts")
    expect(signers.sort()).toEqual(["app/api/parent/orders/[orderId]/final-media/route.ts", "lib/admin/requests/backend-requests.ts"])
    const route = code("app/api/parent/orders/[orderId]/final-media/route.ts")
    // order: authorize (PostgreSQL) -> limiter -> sign -> audit
    expect(route.indexOf("authorizeFinalMedia(")).toBeGreaterThan(-1)
    expect(route.indexOf("authorizeFinalMedia(")).toBeLessThan(route.indexOf("enforceRateLimit("))
    expect(route.indexOf("enforceRateLimit(")).toBeLessThan(route.indexOf("signFinalDeliverable("))
    expect(route.indexOf("signFinalDeliverable(")).toBeLessThan(route.indexOf("recordFinalMediaAccess("))
    // the key passed to the signer is the one PostgreSQL returned, never a request field
    expect(route).toMatch(/signFinalDeliverable\(\s*authorized\.path,/)
    expect(route).not.toMatch(/body\.(path|bucket|key|file_url)|searchParams|formData/)
  })

  it("no admin route reads an actor, role or user id from the browser", () => {
    for (const f of walk("app/api/admin/requests")) {
      expect(code(f), f).not.toMatch(/adminUserId|actorId|body\.userId|x-role|x-user-id|users"\)|isAdminRole/i)
    }
    for (const f of ["backend/src/routes/admin-requests.ts", "backend/src/routes/parent-media.ts"]) {
      expect(code(f), f).not.toMatch(/request\.headers|request\.cookies|x-role|x-user-id|body\.(adminUserId|userId|actorId|parentProfileId|parentId)/i)
      expect(code(f).match(/request\.authPrincipal!\.userId/g)?.length ?? 0).toBeGreaterThan(2)
    }
  })

  it("admin writes in Next: CSRF first, then the verified caller; the multipart upload is gated by the backend BEFORE any byte is stored", () => {
    for (const f of walk("app/api/admin/requests").filter((x) => /route\.ts$/.test(x))) {
      const src = code(f)
      expect(src, f).toMatch(/rejectUnsafeBrowserWrite\(/)
      expect(src.indexOf("rejectUnsafeBrowserWrite("), f).toBeLessThan(src.indexOf("requireAdminFulfilmentAuth("))
    }
    const upload = code("app/api/admin/requests/[requestId]/final-media/route.ts")
    expect(upload).toMatch(/rejectUnsafeBrowserWrite\(request, process\.env, "multipart"\)/)
    expect(upload.indexOf("adminUploadGate(")).toBeGreaterThan(-1)
    expect(upload.indexOf("adminUploadGate(")).toBeLessThan(upload.indexOf("request.formData()"))
    expect(upload.indexOf("adminUploadGate(")).toBeLessThan(upload.indexOf("uploadFinalDeliverable("))
    expect(upload.indexOf("uploadFinalDeliverable(")).toBeLessThan(upload.indexOf("adminRecordFinalMedia("))
  })

  it("backend admin routes: reads need requireAuth + an admin role, writes requireWriteAuth with admin roles only", () => {
    const src = code("backend/src/routes/admin-requests.ts")
    expect(src).toMatch(/const read = \{ preHandler: \[requireAuth\(deps\), requireRole\("admin", "super_admin"\)\] \}/)
    const writes = [...src.matchAll(/app\.(post|put|patch|delete)\(\s*"([^"]+)"[^)]*?preHandler: \[([^\]]*)\]/g)]
    expect(writes).toHaveLength(3)
    for (const w of writes) expect(w[3]).toBe('requireWriteAuth(deps, "admin", "super_admin")')
    expect([...src.matchAll(/app\.get\(\s*"[^"]+",\s*read\b/g)]).toHaveLength(3)
  })

  it("the parent media routes: reads parent-only, the audit write parent-only with exact body keys", () => {
    const src = code("backend/src/routes/parent-media.ts")
    expect(src).toMatch(/const read = \{ preHandler: \[requireAuth\(deps\), requireRole\("parent"\)\] \}/)
    expect(src).toMatch(/requireWriteAuth\(deps, "parent"\)/)
    expect(src).toMatch(/Object\.keys\(body\)\.length !== 2/)
    expect([...src.matchAll(/app\.get\(\s*"[^"]+",\s*read\b/g)]).toHaveLength(4)
  })

  it("the final-media key rules are enforced in the backend before the function, and bound to THIS order", () => {
    const src = code("backend/src/routes/admin-requests.ts")
    expect(src).toMatch(/key\[1\]\.toLowerCase\(\) === requestId\.toLowerCase\(\)/)
    expect(src).toMatch(/FINAL_MEDIA_MIME_TYPES\.includes\(mimeType\)/)
    expect(src).toMatch(/EXT_MIME\[key\[2\]\.toLowerCase\(\)\] === mimeType/)
    expect(src).toMatch(/MAX_FINAL_IMAGE_BYTES : MAX_FINAL_VIDEO_BYTES/)
    expect(src).toMatch(/KEY_RE = \/\^orders\\\/\(\[0-9a-f-\]\{36\}\)\\\/final\\\//)
  })
})

describe("12/28. migration 0018 changes no state machine and pins the data copy", () => {
  const sql = read("database/migrations/0018_order_fulfilment_media.sql").replace(/--.*$/gm, "")

  it("adds exactly one function (the audit insert) and only grants to the application role", () => {
    expect([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["public.record_final_media_access_audit_trusted"])
    expect(sql).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+|CREATE\s+TRIGGER|CREATE\s+ROLE/i)
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO ''/)
    for (const grant of sql.matchAll(/\bGRANT\b[\s\S]*?\bTO\s+(\w+)/gi)) expect(grant[1]).toBe("cartoona_app")
    for (const revoke of sql.matchAll(/REVOKE ALL ON FUNCTION[^;]*FROM (\w+)/g)) expect(revoke[1]).toBe("PUBLIC")
  })

  it("the audit function only records an owner's access to the current approved parent-visible final", () => {
    for (const clause of ["pp.user_id = p_actor_user_id", "ma.asset_role = 'final'", "ma.delivery_status = 'approved'", "ma.parent_visible = TRUE", "ma.order_id = p_order_id"]) {
      expect(sql).toContain(clause)
    }
    expect(sql).toMatch(/p_action NOT IN \('final_media_view', 'final_media_download'\)/)
    expect(sql).toMatch(/pg_catalog\.jsonb_build_object\('orderId', p_order_id\)/)
  })

  it("the data-copy mapping is pinned to the 18 migrations", () => {
    expect(read("scripts/db/data-copy/mapping.ts")).toContain('"0018_order_fulfilment_media"')
  })
})

describe("22. repositories stay constant-SQL with bound parameters", () => {
  for (const f of ["lib/repositories/parent-media.ts", "lib/repositories/admin-requests.ts"]) {
    it(`${f}: no template interpolation inside SQL, ids validated`, () => {
      const src = code(f)
      expect(src).not.toMatch(/\$\{/)
      expect(src).toMatch(/requireUuid\(/)
      expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?public\./i)
    })
  }
})

import { describe, it, expect } from "vitest"
import { AuthRetryableFetchError, AuthApiError } from "@supabase/supabase-js"
import { resolveParentRequestContext } from "@/lib/parent/parent-request-context"
import { getParentOrderDetail } from "@/lib/parent/orders/detail-queries"
import { createFakeSupabase, uuid, ts } from "../helpers/fake-supabase"
import type { SessionKind } from "../helpers/supabase-jwt"

const ME = "profile-me"
const USER = { id: "user-1" }

function world(over: { role?: string; session?: SessionKind; profile?: boolean; auth?: object } = {}) {
  return createFakeSupabase({
    ...(over.auth ?? { user: USER }),
    tables: {
      users: [{ id: USER.id, role: over.role ?? "parent" }],
      parent_profiles: over.profile === false ? [] : [{ id: ME, user_id: USER.id }],
    },
    session: over.session,
  })
}

describe("ParentRequestContext (full)", () => {
  it("resolves user, role and profile with one network call each; the lifetime needs none (V0.1.43)", async () => {
    const { client, calls } = world()
    const r = await resolveParentRequestContext(client, { verify: "full" })
    expect(r).toEqual({ ok: true, context: { userId: USER.id, role: "parent", parentProfileId: ME } })
    expect(calls.getUser).toBe(1)
    expect(calls.from.users).toBe(1)
    expect(calls.from.parent_profiles).toBe(1)
    // The lifetime is read from the verified session locally: no RPC any more.
    expect(calls.rpc).toHaveLength(0)
    expect(calls.getSession).toBe(1)
    expect(calls.total()).toBe(3)
  })

  it("is request-scoped: a second resolve is a fresh lookup, nothing is cached between calls", async () => {
    const { client, calls } = world()
    await resolveParentRequestContext(client, { verify: "full" })
    await resolveParentRequestContext(client, { verify: "full" })
    expect(calls.getUser).toBe(2)
  })

  it("expired session -> session_invalid carrying the expired lifetime (existing 401 + signOut path)", async () => {
    const { client } = world({ session: "expired" })
    const r = await resolveParentRequestContext(client, { verify: "full" })
    expect(r).toMatchObject({ ok: false, reason: "session_invalid", lifetime: { valid: false, reason: "expired" } })
  })

  it("lookup_failed stays retryable: session_invalid/lookup_failed, never reported as expired", async () => {
    const { client } = world({ session: "transient" })
    const r = await resolveParentRequestContext(client, { verify: "full" })
    expect(r).toMatchObject({ ok: false, reason: "session_invalid", lifetime: { reason: "lookup_failed" } })
  })

  it("never signs out on any outcome", async () => {
    for (const session of ["transient", "missing", "expired"] as const) {
      const { client } = world({ session })
      let signedOut = false
      ;(client as unknown as { auth: { signOut: () => Promise<unknown> } }).auth.signOut = async () => ((signedOut = true), {})
      await resolveParentRequestContext(client, { verify: "full" })
      expect(signedOut).toBe(false)
    }
  })

  it("non-parent (admin / super_admin / unknown) is denied and never becomes a parent", async () => {
    for (const role of ["admin", "super_admin", "creator", ""]) {
      const { client } = world({ role })
      expect(await resolveParentRequestContext(client, { verify: "full" })).toEqual({ ok: false, reason: "not_parent" })
    }
  })

  it("an admin is denied even with a valid lifetime and a profile row", async () => {
    const { client } = world({ role: "admin" })
    const r = await resolveParentRequestContext(client, { verify: "full" })
    expect(r.ok).toBe(false)
  })

  it("no parent profile", async () => {
    const { client } = world({ profile: false })
    expect(await resolveParentRequestContext(client, { verify: "full" })).toEqual({ ok: false, reason: "no_parent_profile" })
  })

  it("unauthenticated vs transient auth failure are different; transient is auth_unavailable (not 'logged out')", async () => {
    const none = world({ auth: { user: null } })
    expect(await resolveParentRequestContext(none.client, { verify: "full" })).toEqual({ ok: false, reason: "unauthenticated" })
    expect(none.calls.total()).toBe(1) // stops after getUser

    const invalid = world({ auth: { user: null, authError: new AuthApiError("invalid JWT", 401, "bad_jwt") } })
    expect(await resolveParentRequestContext(invalid.client, { verify: "full" })).toEqual({ ok: false, reason: "unauthenticated" })

    const transient = world({ auth: { user: null, authError: new AuthRetryableFetchError("Request timed out after 10000ms", 0) } })
    expect(await resolveParentRequestContext(transient.client, { verify: "full" })).toEqual({ ok: false, reason: "auth_unavailable" })
    expect(transient.calls.total()).toBe(1)
  })

  it("a failed role read is read_failed, not 'not_parent'", async () => {
    const f = createFakeSupabase({ user: USER, tables: { users: [], parent_profiles: [{ id: ME, user_id: USER.id }] }, tableErrors: { users: { message: "timeout" } } })
    expect(await resolveParentRequestContext(f.client, { verify: "full" })).toEqual({ ok: false, reason: "read_failed" })
  })
})

describe("ParentRequestContext (identity) - for pages behind middleware", () => {
  it("one getUser + one profile read; role and lifetime are middleware's job (no extra calls)", async () => {
    const { client, calls } = world()
    const r = await resolveParentRequestContext(client, { verify: "identity" })
    expect(r).toEqual({ ok: true, context: { userId: USER.id, role: null, parentProfileId: ME } })
    expect(calls.getUser).toBe(1)
    expect(calls.from.parent_profiles).toBe(1)
    expect(calls.from.users).toBeUndefined()
    expect(calls.rpc).toHaveLength(0)
    expect(calls.total()).toBe(2)
  })

  it("admin without a parent profile still lands on no_parent_profile (same as before)", async () => {
    const { client } = world({ role: "admin", profile: false })
    expect(await resolveParentRequestContext(client, { verify: "identity" })).toEqual({ ok: false, reason: "no_parent_profile" })
  })
})

describe("order detail reuses the context", () => {
  const OID = uuid(7)
  function detailWorld(extra: Record<string, unknown[]> = {}, rpc: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
    return createFakeSupabase({
      user: USER,
      tables: {
        orders: [
          { id: OID, parent_id: ME, type: "image", status: "delivered", title: "Mine", description: "d", child_name: null, candy_cost: 2, created_at: ts(1), characters: { name: "Robo" } },
          { id: uuid(8), parent_id: "profile-other", type: "image", status: "delivered", title: "Theirs", created_at: ts(2) },
        ],
        media_assets: [
          { id: "m1", order_id: OID, type: "upload", file_url: "u/o/a.png", mime_type: "image/png", created_at: ts(1) },
          { id: "m2", order_id: OID, type: "upload", file_url: "u/o/b.png", mime_type: "image/png", created_at: ts(2) },
          { id: "f1", order_id: OID, type: "generated", asset_role: "final", delivery_status: "approved", parent_visible: true, file_url: "final/x.mp4", mime_type: "video/mp4", original_filename: "x.mp4", created_at: ts(3) },
        ],
        ...extra,
      },
      rpc: { get_parent_order_status_history: () => [], ...rpc },
    })
  }

  it("makes NO auth / profile / role calls: identity is the caller's", async () => {
    const { client, calls } = detailWorld()
    const r = await getParentOrderDetail(client, OID, { parentProfileId: ME })
    expect(r.ok).toBe(true)
    expect(calls.getUser).toBe(0)
    expect(calls.from.parent_profiles).toBeUndefined()
    expect(calls.from.users).toBeUndefined()
  })

  it("only necessary data queries: orders, media (source), final media, history; ONE batched signing call", async () => {
    const { client, calls } = detailWorld()
    await getParentOrderDetail(client, OID, { parentProfileId: ME })
    expect(calls.from.orders).toBe(1)
    expect(calls.from.media_assets).toBe(2) // source uploads + final lookup
    expect(calls.from.video_requests).toBeUndefined() // image order: no extension query
    expect(calls.rpc.map((c) => c.fn)).toEqual(["get_parent_order_status_history"])
    expect(calls.storageBatch).toBe(1)
    expect(calls.storageSingle).toBe(0) // was one call per source file
  })

  it("a foreign order is not_found, identical to a non-existent id, and nothing else is read or signed", async () => {
    for (const id of [uuid(8), uuid(99)]) {
      const { client, calls } = detailWorld()
      expect(await getParentOrderDetail(client, id, { parentProfileId: ME })).toEqual({ ok: false, reason: "not_found" })
      expect(calls.from.media_assets).toBeUndefined()
      expect(calls.rpc).toHaveLength(0)
      expect(calls.storageBatch + calls.storageSingle).toBe(0)
    }
  })

  it("a malformed id is not_found without any backend call", async () => {
    const { client, calls } = detailWorld()
    expect(await getParentOrderDetail(client, "not-a-uuid", { parentProfileId: ME })).toEqual({ ok: false, reason: "not_found" })
    expect(calls.total()).toBe(0)
  })

  it("final-media eligibility preserved: approved+visible final -> metadata only, no URL or path", async () => {
    const { client } = detailWorld()
    const r = await getParentOrderDetail(client, OID, { parentProfileId: ME })
    if (!r.ok) throw new Error()
    expect(r.detail.finalMedia).toEqual({ id: "f1", mimeType: "video/mp4", fileName: "x.mp4" })
    expect(JSON.stringify(r.detail)).not.toContain("final/x.mp4")
    // Source media is signed; the final deliverable is not signed here.
    expect(r.detail.sourceMedia).toHaveLength(2)
    expect(r.detail.sourceMedia.every((m) => m.signedUrl?.startsWith("https://s/"))).toBe(true)
    expect(JSON.stringify(r.detail.sourceMedia)).not.toContain("u/o/a.png")
  })

  it("unapproved or hidden finals are not eligible", async () => {
    const { client } = createFakeSupabase({
      user: USER,
      tables: {
        orders: [{ id: OID, parent_id: ME, type: "image", status: "delivered", title: "Mine", created_at: ts(1) }],
        media_assets: [{ id: "f2", order_id: OID, asset_role: "final", delivery_status: "pending", parent_visible: true, file_url: "p", created_at: ts(1) }],
      },
      rpc: { get_parent_order_status_history: () => [] },
    })
    const r = await getParentOrderDetail(client, OID, { parentProfileId: ME })
    expect(r.ok && r.detail.finalMedia).toBeNull()
  })

  it("deliveredAt still comes from the status-history RPC", async () => {
    const { client } = detailWorld({}, {
      get_parent_order_status_history: () => [
        { new_status: "pending_review", created_at: "2026-03-01T00:00:00Z" },
        { new_status: "delivered", created_at: "2026-03-05T00:00:00Z" },
      ],
    })
    const r = await getParentOrderDetail(client, OID, { parentProfileId: ME })
    expect(r.ok && r.detail.completedAt).toBe("2026-03-05T00:00:00Z")
  })

  it("a read error on the order is read_failed", async () => {
    const f = createFakeSupabase({ user: USER, tables: { orders: [] }, tableErrors: { orders: { message: "x" } } })
    expect(await getParentOrderDetail(f.client, OID, { parentProfileId: ME })).toEqual({ ok: false, reason: "read_failed" })
  })
})

describe("backend-call accounting (code-path count, not a latency claim)", () => {
  it("orders list page: 5 sequential backend calls before -> 4 after (getUser x2 -> x1), with no extra auth calls", async () => {
    const { getParentOrdersPage } = await import("@/lib/parent/orders/queries")
    const f = createFakeSupabase({
      user: USER,
      tables: { users: [{ id: USER.id, role: "parent" }], parent_profiles: [{ id: ME, user_id: USER.id }], orders: [{ id: uuid(1), parent_id: ME, type: "image", status: "pending_review", title: "t", candy_cost: 1, created_at: ts(1) }] },
      rpc: { get_parent_orders_delivered_at: (a) => (a.p_order_ids as string[]).map((id) => ({ order_id: id, delivered_at: "2026-03-02T00:00:00Z" })) },
    })
    const ctx = await resolveParentRequestContext(f.client, { verify: "identity" })
    if (!ctx.ok) throw new Error()
    await getParentOrdersPage(f.client, ctx.context)
    // getUser, parent_profiles, orders, delivered_at RPC
    expect(f.calls.total()).toBe(4)
    expect(f.calls.getUser).toBe(1)
  })
})

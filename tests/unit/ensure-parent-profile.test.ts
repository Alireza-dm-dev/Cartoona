import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ensureParentProfile } from "@/lib/parent/ensure-parent-profile"

/**
 * A minimal in-memory stand-in for the one table this helper touches. It models
 * the UNIQUE constraint on user_id, which is what makes the helper idempotent,
 * so the tests exercise the same failure the database would produce.
 */
interface Row {
  id: string
  user_id: string
  full_name: string
  consent_granted: boolean
  consent_granted_at: string | null
}

interface FakeOptions {
  rows?: Row[]
  failSelect?: boolean
  failInsert?: boolean
  failUpdate?: boolean
  /** Simulates a concurrent insert landing between the select and the insert. */
  insertRace?: Row
}

function makeClient(opts: FakeOptions = {}) {
  const rows: Row[] = opts.rows ? [...opts.rows] : []
  const calls = { selects: 0, inserts: 0, updates: 0 }

  const client = {
    from(table: string) {
      if (table !== "parent_profiles") throw new Error(`unexpected table ${table}`)

      return {
        select() {
          return {
            eq(_col: string, userId: string) {
              return {
                maybeSingle: async () => {
                  calls.selects += 1
                  if (opts.failSelect) return { data: null, error: { message: "boom" } }
                  const found = rows.find((r) => r.user_id === userId) ?? null
                  return { data: found, error: null }
                },
              }
            },
          }
        },

        insert(values: Omit<Row, "id">) {
          return {
            select() {
              return {
                maybeSingle: async () => {
                  calls.inserts += 1
                  if (opts.failInsert) {
                    return { data: null, error: { code: "XX000", message: "boom" } }
                  }
                  if (opts.insertRace && !rows.some((r) => r.user_id === values.user_id)) {
                    rows.push(opts.insertRace)
                  }
                  if (rows.some((r) => r.user_id === values.user_id)) {
                    return { data: null, error: { code: "23505", message: "duplicate key" } }
                  }
                  const row: Row = { id: `profile-${rows.length + 1}`, ...values }
                  rows.push(row)
                  return { data: { id: row.id }, error: null }
                },
              }
            },
          }
        },

        update(patch: Partial<Row>) {
          return {
            eq: async (_col: string, userId: string) => {
              calls.updates += 1
              if (opts.failUpdate) return { error: { message: "boom" } }
              const row = rows.find((r) => r.user_id === userId)
              if (row) Object.assign(row, patch)
              return { error: null }
            },
          }
        },
      }
    },
  }

  return { client: client as unknown as SupabaseClient, rows, calls }
}

const USER = "user-1"
const NAME = "مریم احمدی"

describe("production signup creates exactly one parent profile", () => {
  it("creates the profile when none exists", async () => {
    const { client, rows } = makeClient()

    const result = await ensureParentProfile(client, {
      userId: USER,
      fullName: NAME,
      consent: "preserve",
    })

    expect(result).toEqual({ ok: true, created: true, profileId: "profile-1" })
    expect(rows).toHaveLength(1)
    expect(rows[0].full_name).toBe(NAME)
  })

  it("starts a new profile un-consented", async () => {
    const { client, rows } = makeClient()
    await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(rows[0].consent_granted).toBe(false)
    expect(rows[0].consent_granted_at).toBeNull()
  })

  it("trims the stored name", async () => {
    const { client, rows } = makeClient()
    await ensureParentProfile(client, { userId: USER, fullName: "  مریم احمدی  ", consent: "preserve" })
    expect(rows[0].full_name).toBe(NAME)
  })
})

describe("idempotency", () => {
  it("a retry does not create a second profile", async () => {
    const { client, rows } = makeClient()

    const first = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })
    const second = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })
    const third = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(first).toMatchObject({ ok: true, created: true })
    expect(second).toMatchObject({ ok: true, created: false, profileId: "profile-1" })
    expect(third).toMatchObject({ ok: true, created: false, profileId: "profile-1" })
    expect(rows).toHaveLength(1)
  })

  it("an existing profile is adopted, not duplicated", async () => {
    const { client, rows, calls } = makeClient({
      rows: [{
        id: "existing", user_id: USER, full_name: "نام قبلی",
        consent_granted: false, consent_granted_at: null,
      }],
    })

    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(result).toEqual({ ok: true, created: false, profileId: "existing" })
    expect(rows).toHaveLength(1)
    expect(calls.inserts).toBe(0)
    // An existing name is authoritative and must not be overwritten by signup.
    expect(rows[0].full_name).toBe("نام قبلی")
  })

  it("resolves a concurrent insert by adopting the winning row", async () => {
    const { client, rows } = makeClient({
      insertRace: {
        id: "winner", user_id: USER, full_name: NAME,
        consent_granted: false, consent_granted_at: null,
      },
    })

    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(result).toEqual({ ok: true, created: false, profileId: "winner" })
    expect(rows).toHaveLength(1)
  })

  it("does not duplicate across different users", async () => {
    const { client, rows } = makeClient()
    await ensureParentProfile(client, { userId: "user-a", fullName: NAME, consent: "preserve" })
    await ensureParentProfile(client, { userId: "user-b", fullName: NAME, consent: "preserve" })
    expect(rows).toHaveLength(2)
  })
})

describe("consent intent", () => {
  it("grant records consent on a new profile", async () => {
    const { client, rows } = makeClient()
    await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "grant" })

    expect(rows[0].consent_granted).toBe(true)
    expect(rows[0].consent_granted_at).not.toBeNull()
  })

  it("grant moves an existing un-consented profile forward", async () => {
    const { client, rows } = makeClient({
      rows: [{
        id: "existing", user_id: USER, full_name: NAME,
        consent_granted: false, consent_granted_at: null,
      }],
    })

    await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "grant" })

    expect(rows[0].consent_granted).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it("preserve never revokes consent already granted", async () => {
    const { client, rows, calls } = makeClient({
      rows: [{
        id: "existing", user_id: USER, full_name: NAME,
        consent_granted: true, consent_granted_at: "2026-01-01T00:00:00.000Z",
      }],
    })

    await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(rows[0].consent_granted).toBe(true)
    expect(rows[0].consent_granted_at).toBe("2026-01-01T00:00:00.000Z")
    expect(calls.updates).toBe(0)
  })

  it("grant on an already-consented profile writes nothing", async () => {
    const { client, calls } = makeClient({
      rows: [{
        id: "existing", user_id: USER, full_name: NAME,
        consent_granted: true, consent_granted_at: "2026-01-01T00:00:00.000Z",
      }],
    })

    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "grant" })

    expect(result).toMatchObject({ ok: true, created: false })
    expect(calls.updates).toBe(0)
  })
})

describe("failure handling", () => {
  it("reports a failed read rather than inserting blindly", async () => {
    const { client, rows } = makeClient({ failSelect: true })

    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(result).toEqual({ ok: false, reason: "write_failed" })
    expect(rows).toHaveLength(0)
  })

  it("reports a failed insert", async () => {
    const { client, rows } = makeClient({ failInsert: true })

    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })

    expect(result).toEqual({ ok: false, reason: "write_failed" })
    expect(rows).toHaveLength(0)
  })

  it("reports a failed consent update", async () => {
    const { client } = makeClient({
      failUpdate: true,
      rows: [{
        id: "existing", user_id: USER, full_name: NAME,
        consent_granted: false, consent_granted_at: null,
      }],
    })

    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "grant" })

    expect(result).toEqual({ ok: false, reason: "write_failed" })
  })

  it("refuses to create a profile without a name", async () => {
    const { client, rows, calls } = makeClient()

    for (const name of ["", "   "]) {
      const result = await ensureParentProfile(client, { userId: USER, fullName: name, consent: "preserve" })
      expect(result).toEqual({ ok: false, reason: "missing_name" })
    }

    expect(rows).toHaveLength(0)
    expect(calls.selects).toBe(0)
  })

  it("never leaks a database message in its result", async () => {
    const { client } = makeClient({ failInsert: true })
    const result = await ensureParentProfile(client, { userId: USER, fullName: NAME, consent: "preserve" })
    expect(JSON.stringify(result)).not.toContain("boom")
  })
})

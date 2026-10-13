/**
 * Minimal in-memory stand-in for the slice of supabase-js the parent orders
 * code uses. It EXECUTES the filters (eq / in / or-cursor / order / limit) so
 * pagination tests prove behaviour, not just call shapes, and it records every
 * backend call so tests can assert exact round-trip counts.
 */
type Row = Record<string, unknown>

export interface FakeCalls {
  getUser: number
  from: Record<string, number>
  rpc: { fn: string; args: Record<string, unknown> }[]
  storageBatch: number
  storageSingle: number
  limits: number[]
  total(): number
}

export interface FakeOptions {
  user?: { id: string } | null
  authError?: unknown
  tables?: Record<string, Row[]>
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>
  tableErrors?: Record<string, { message: string }>
}

// "created_at.lt.X,and(created_at.eq.X,id.lt.Y)" - the only .or() shape in use.
function parseCursorOr(expr: string): ((r: Row) => boolean) | null {
  const m = /^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(.+)\)$/.exec(expr)
  if (!m) return null
  const [, lt, eq, id] = m
  return (r) => {
    const c = String(r.created_at)
    return c < lt || (c === eq && String(r.id) < id)
  }
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)

export function createFakeSupabase(opts: FakeOptions = {}) {
  const calls: FakeCalls = {
    getUser: 0,
    from: {},
    rpc: [],
    storageBatch: 0,
    storageSingle: 0,
    limits: [],
    total() {
      return (
        this.getUser +
        Object.values(this.from).reduce((a, b) => a + b, 0) +
        this.rpc.length +
        this.storageBatch +
        this.storageSingle
      )
    },
  }
  const tables = opts.tables ?? {}

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    const orders: { col: string; asc: boolean }[] = []
    let max = Infinity
    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = String(a[o.col]), y = String(b[o.col])
          return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1)
        })
      }
      return rows.slice(0, max)
    }
    const err = opts.tableErrors?.[table] ?? null
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), b),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), b),
      or: (expr: string) => {
        const f = parseCursorOr(expr)
        if (!f) throw new Error(`unsupported or(): ${expr}`)
        filters.push(f)
        return b
      },
      order: (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((max = n), calls.limits.push(n), b),
      maybeSingle: async () => (err ? { data: null, error: err } : { data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve(err ? { data: null, error: err } : { data: run(), error: null }),
    }
    return b
  }

  const client = {
    auth: {
      getUser: async () => {
        calls.getUser++
        if (opts.authError) return { data: { user: null }, error: opts.authError }
        return { data: { user: opts.user ?? null }, error: null }
      },
      signOut: async () => ({}),
    },
    from: (table: string) => {
      calls.from[table] = (calls.from[table] ?? 0) + 1
      return builder(table)
    },
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      calls.rpc.push({ fn, args })
      const impl = opts.rpc?.[fn]
      const data = impl ? impl(args) : null
      return Object.assign(Promise.resolve({ data, error: null }), {})
    },
    storage: {
      from: () => ({
        createSignedUrl: async (p: string) => {
          calls.storageSingle++
          return { data: { signedUrl: `https://s/opaque-${Math.abs(hash(p))}?t=1` }, error: null }
        },
        createSignedUrls: async (paths: string[]) => {
          calls.storageBatch++
          return { data: paths.map((p) => ({ path: p, signedUrl: `https://s/opaque-${Math.abs(hash(p))}?t=1`, error: null })), error: null }
        },
      }),
    },
  }
  return { client: client as never, calls }
}

export const VALID_LIFETIME = [
  { is_valid: true, session_started_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-31T00:00:00Z" },
]

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const ts = (n: number) =>
  `${new Date(Date.UTC(2026, 2, 1) + n * 1000).toISOString().slice(0, 19)}.${String(n).padStart(6, "0")}+00:00`

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"

/**
 * REAL-SQL tests for the V0.1.38 plain-PostgreSQL baseline (database/migrations).
 *
 * Opt-in: CARTOONA_PLAIN_PG=docker runs them against the compose `postgres`
 * service (`docker compose up -d postgres`). Unset => skipped, so `npm test`
 * needs no database. psql runs inside that container, so the host needs no
 * client.
 *
 * Safety: the suite creates and drops its OWN uniquely named databases
 * (plain_<id> and a Supabase reference build ref_<id>) and never touches the
 * `cartoona` database. Nothing here can reach a hosted project: the only
 * connection is `docker exec` into the local container.
 *
 * The baseline is applied with the real runner, scripts/db/migrate-local.sh.
 * The reference build applies the untouched supabase/migrations chain on top
 * of tests/helpers/supabase-stub.sql, so schema parity is checked against the
 * real current schema, not against a hand-written expectation.
 */

const run = promisify(execFile)
const enabled = process.env.CARTOONA_PLAIN_PG === "docker"
const root = process.cwd()
const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const DB = `plain_${id}`
const REF = `ref_${id}`
// Data-cleanup migrations that assert production row counts.
const SKIPPED_ON_EMPTY_DB = ["20260727121000", "20260727122000", "20260727123000"]

let container = ""

function psqlArgs(db: string) {
  return ["exec", "-i", container, "psql", "-U", "cartoona", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db]
}

async function psql(sql: string, opts: { db?: string; file?: string } = {}): Promise<string> {
  const args = [...psqlArgs(opts.db ?? DB), "-c", "SET client_min_messages = warning"]
  if (opts.file) {
    const child = run("docker", [...args, "-f", "-"], { maxBuffer: 64 * 1024 * 1024 })
    child.child.stdin?.end(fs.readFileSync(opts.file))
    return (await child).stdout.trim()
  }
  const { stdout } = await run("docker", [...args, "-c", sql], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

/** Run SQL and return { ok, out, err } instead of throwing (constraint / RPC errors are expected data here). */
async function attempt(sql: string, db = DB): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    return { ok: true, out: await psql(sql, { db }), err: "" }
  } catch (e) {
    return { ok: false, out: "", err: String((e as { stderr?: string }).stderr ?? e) }
  }
}

let counter = 0
const uuid = (): string => {
  counter += 1
  const hex = (Date.now() * 1000 + counter).toString(16).padStart(12, "0").slice(-12)
  return `bbbbbbbb-0000-4000-8000-${hex}`
}

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Parent { userId: string; profileId: string }

/** A user is created by the backend now - no external auth table, no trigger. */
async function createUser(role = "parent"): Promise<string> {
  return psql(`insert into public.users (email, role) values ('u${uuid().slice(-12)}@x.test', '${role}') returning id`)
}

async function createParent(opts: { candy?: number } = {}): Promise<Parent> {
  const userId = await createUser()
  const profileId = await psql(
    `insert into public.parent_profiles (user_id, consent_granted) values ('${userId}', true) returning id`,
  )
  if (opts.candy) await psql(`update public.candy_wallets set balance=${opts.candy} where parent_id='${profileId}'`)
  return { userId, profileId }
}

const credits = async (p: Parent) =>
  (await psql(`select granted_count||','||used_count from public.parent_welcome_credits where parent_id='${p.profileId}'`)) || "none"
const balance = async (p: Parent) => Number(await psql(`select balance from public.candy_wallets where parent_id='${p.profileId}'`))
const ledgerCount = async (p: Parent) =>
  Number(await psql(`select count(*) from public.candy_transactions t join public.candy_wallets w on w.id=t.wallet_id where w.parent_id='${p.profileId}'`))
const orderCount = async (p: Parent) => Number(await psql(`select count(*) from public.orders where parent_id='${p.profileId}'`))
const usageCount = async (p: Parent) => Number(await psql(`select count(*) from public.parent_welcome_credit_usages where parent_id='${p.profileId}'`))

let characterId = ""

interface SubmitOpts {
  type?: "image" | "video" | "drawing_animation"
  key?: string | null
  orderId?: string
  /** drawing_animation only: what the backend verified. Defaults to a valid image. */
  mime?: string | null
  filePath?: string
}

/** The exact RPC call the request route makes, as one statement (one transaction). */
function submitSql(p: Parent, o: SubmitOpts = {}): string {
  const type = o.type ?? "image"
  const key = o.key === undefined ? uuid() : o.key
  const orderId = o.orderId ?? uuid()
  const video = type === "video"
  const anim = type === "drawing_animation"
  const file = anim ? `'${o.filePath ?? `${p.userId}/${orderId}/draw.png`}'` : "null"
  const mime = anim ? (o.mime === null ? "null" : `'${o.mime ?? "image/png"}'`) : "null"
  return `select id||'|'||type||'|'||candy_cost||'|'||replayed||'|'||payment_source from public.create_parent_request_trusted(
    '${p.profileId}', '${orderId}', '${type}', ${anim ? "'t'" : "null"}, null,
    ${anim ? "null" : `'${characterId}'`}, ${video || anim ? "'short'" : "null"},
    ${video ? "'script'" : "null"}, null, ${anim ? "'wave'" : "null"}, ${file}, ${video ? "'5_10'" : "null"},
    ${video ? "false" : "null"}, null, null, ${key === null ? "null" : `'${key}'`}, ${mime})`
}

interface Outcome { ok: boolean; id?: string; type?: string; cost?: number; replayed?: boolean; source?: string; error?: string }

function toOutcome(r: { ok: boolean; out: string; err: string }): Outcome {
  if (!r.ok) {
    const code = /\b(INSUFFICIENT_CANDIES|request_[a-z_]+)\b/.exec(r.err)?.[1]
    return { ok: false, error: code ?? r.err.slice(0, 200) }
  }
  const [oid, type, cost, replayed, source] = r.out.split("|")
  return { ok: true, id: oid, type, cost: Number(cost), replayed: replayed === "true", source }
}

const submit = async (p: Parent, o: SubmitOpts = {}) => toOutcome(await attempt(submitSql(p, o)))

/**
 * Run `sqls` as truly simultaneous sessions. A controller session holds an
 * exclusive advisory lock; every worker blocks on a shared lock for it; once ALL
 * workers are provably waiting, the controller's backend is terminated and they
 * are released at the same instant. Without this, serially spawned clients
 * finish one call before the next even connects and nothing would race.
 */
async function runSimultaneously(sqls: string[]): Promise<{ ok: boolean; out: string; err: string }[]> {
  const BARRIER = 7_770_038
  const controller = spawn("docker", [...psqlArgs(DB), "-c", `select pg_advisory_lock(${BARRIER}); select pg_sleep(120)`], { stdio: "ignore" })
  const release = () =>
    psql(`select pg_terminate_backend(pid) from pg_locks where locktype='advisory' and objid=${BARRIER} and granted and mode='ExclusiveLock'`)
  const waitFor = async (sql: string, want: number) => {
    for (let i = 0; i < 600; i++) {
      if (Number(await psql(sql)) >= want) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`barrier condition not reached: ${sql}`)
  }
  try {
    await waitFor(`select count(*) from pg_locks where locktype='advisory' and objid=${BARRIER} and granted`, 1)
    const workers = sqls.map((sql) =>
      attempt(`select pg_advisory_lock_shared(${BARRIER}); ${sql}`).then((r) => ({ ...r, out: r.out.split("\n").pop() ?? "" })),
    )
    await waitFor(`select count(*) from pg_locks where locktype='advisory' and objid=${BARRIER} and not granted`, sqls.length)
    await release()
    return await Promise.all(workers)
  } finally {
    controller.kill("SIGKILL")
    await release().catch(() => undefined)
  }
}

const submitMany = async (p: Parent, n: number, o: () => SubmitOpts = () => ({})) =>
  (await runSimultaneously(Array.from({ length: n }, () => submitSql(p, o())))).map(toOutcome)

// ── catalog snapshots for parity ─────────────────────────────────────────────

const CATALOG: Record<string, string> = {
  tables: `select tablename from pg_tables where schemaname='public' order by 1`,
  columns: `select table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(column_default,'') from information_schema.columns where table_schema='public' order by 1`,
  constraints: `select conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace order by 1`,
  indexes: `select indexname||' '||indexdef from pg_indexes where schemaname='public' order by 1`,
  triggers: `select pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by 1`,
  functions: `select p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(p.prosrc)||' definer='||p.prosecdef
    from pg_proc p where p.pronamespace='public'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') order by 1`,
}

async function catalog(db: string, key: string): Promise<string[]> {
  const out = await psql(CATALOG[key], { db })
  return out ? out.split("\n") : []
}

const diff = (a: string[], b: string[]) => ({
  onlyInPlain: a.filter((x) => !b.includes(x)),
  onlyInSupabase: b.filter((x) => !a.includes(x)),
})

const fnName = (row: string) => row.slice(0, row.indexOf("("))

// ── suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!enabled)("plain PostgreSQL baseline (real SQL, local Docker PostgreSQL 17)", () => {
  vi.setConfig({ testTimeout: 90_000 })

  beforeAll(async () => {
    container = (await run("docker", ["compose", "ps", "-q", "postgres"], { cwd: root })).stdout.trim()
    if (!container) throw new Error("compose postgres service is not running: docker compose up -d postgres")

    await psql(`create database ${DB}`, { db: "postgres" })
    await psql(`create database ${REF}`, { db: "postgres" })

    // The plain chain, through the real runner (inside the container).
    const { stdout } = await run("bash", [path.join(root, "scripts/db/migrate-local.sh")], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PSQL: path.join(root, "scripts/db/psql-docker.sh"),
        CARTOONA_PG_CONTAINER: container,
        DATABASE_URL: `postgresql://cartoona@postgres:5432/${DB}`,
      },
    })
    expect(stdout).toMatch(/done - 9 applied/)

    // The Supabase reference: real historical chain over the stub.
    await psql("", { db: REF, file: path.join(root, "tests/helpers/supabase-stub.sql") })
    const dir = path.join(root, "supabase/migrations")
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      if (SKIPPED_ON_EMPTY_DB.some((p) => f.startsWith(p))) continue
      await psql("", { db: REF, file: path.join(dir, f) })
    }

    characterId = await psql("select id from public.characters where is_active limit 1")
  }, 240_000)

  afterAll(async () => {
    if (!container) return
    await psql(`drop database if exists ${DB} with (force)`, { db: "postgres" })
    await psql(`drop database if exists ${REF} with (force)`, { db: "postgres" })
  })

  describe("A. built from empty, with no Supabase dependency", () => {
    it("records every baseline migration exactly once", async () => {
      const versions = (await psql("select version from public.schema_migrations order by 1")).split("\n")
      const files = fs.readdirSync(path.join(root, "database/migrations")).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort()
      expect(versions).toEqual(files)
    })

    it("runs on PostgreSQL 17", async () => {
      expect(await psql("show server_version_num")).toMatch(/^17\d{4}$/)
    })

    it("creates no auth, storage or extensions schema", async () => {
      const schemas = await psql(`select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`)
      expect(schemas).toBe("public")
    })

    it("has no RLS and no policies - authorization moves to the backend", async () => {
      expect(await psql("select count(*) from pg_policies")).toBe("0")
      expect(await psql("select count(*) from pg_class where relnamespace='public'::regnamespace and relrowsecurity")).toBe("0")
    })

    it("depends on no Supabase role (no grant, ownership or policy refers to one)", async () => {
      const n = await psql(`select count(*) from pg_shdepend s join pg_roles r on r.oid=s.refobjid
        where s.dbid=(select oid from pg_database where datname=current_database())
          and r.rolname in ('anon','authenticated','service_role')`)
      expect(n).toBe("0")
    })

    it("no function body references auth.*, storage.* or the extensions schema", async () => {
      expect(await psql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and prosrc ~ '\\m(auth|storage|extensions)\\.'`)).toBe("0")
    })

    it("PUBLIC cannot execute any SECURITY DEFINER function", async () => {
      expect(await psql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and prosecdef and has_function_privilege('public', oid, 'execute')`)).toBe("0")
    })

    it("has every essential domain table", async () => {
      const tables = (await psql("select string_agg(tablename, ',') from pg_tables where schemaname='public'")).split(",")
      for (const t of [
        "users", "user_identities", "parent_profiles", "child_profiles", "orders", "media_assets",
        "order_status_history", "video_requests", "drawing_animation_requests", "candy_wallets",
        "candy_transactions", "candy_packages", "candy_purchases", "payment_attempts",
        "payment_webhook_events", "creation_pricing", "coupons", "coupon_package_rules",
        "coupon_redemptions", "referral_relationships", "referral_program_settings",
        "referral_program_settings_history", "referral_binding_rate_limits", "homepage_content",
        "homepage_media_assets", "homepage_hero_layout", "examples", "characters", "audit_logs",
        "moderation_logs", "parent_welcome_credits", "parent_welcome_credit_usages",
      ]) {
        expect(tables, t).toContain(t)
      }
    })

    it("loads the reference data the business functions need", async () => {
      expect(await psql("select count(*) from public.creation_pricing where is_active")).toBe("9")
      expect(await psql("select count(*) from public.characters where is_active")).toBe("10")
      expect(await psql("select count(*) from public.candy_packages")).toBe("3")
      expect(await psql("select count(*) from public.referral_program_settings where id = 1")).toBe("1")
    })
  })

  describe("B. schema parity with the migrated Supabase schema", () => {
    it("tables: identical, plus user_identities and schema_migrations", async () => {
      const d = diff(await catalog(DB, "tables"), await catalog(REF, "tables"))
      expect(d.onlyInPlain.sort()).toEqual(["schema_migrations", "user_identities"])
      expect(d.onlyInSupabase).toEqual([])
    })

    it("columns: identical except users.id, which now has a default", async () => {
      const d = diff(await catalog(DB, "columns"), await catalog(REF, "columns"))
      const added = d.onlyInPlain.filter((c) => !c.startsWith("user_identities.") && !c.startsWith("schema_migrations."))
      expect(added).toEqual(["users.id uuid null=NO default=gen_random_uuid()"])
      expect(d.onlyInSupabase).toEqual(["users.id uuid null=NO default="])
    })

    it("constraints: identical except the dropped FK to the external auth table", async () => {
      const d = diff(await catalog(DB, "constraints"), await catalog(REF, "constraints"))
      // pg_dump prints `(a AND b) AND c` as `a AND b AND c`; re-parsed, the
      // catalog keeps the flat form. Same predicate - allowed for exactly this
      // pair, and only when the AND-flattening is the whole difference.
      const reassociated = "orders orders_child_name_check"
      const refChild = d.onlyInSupabase.find((c) => c.startsWith(reassociated))
      const plainChild = d.onlyInPlain.find((c) => c.startsWith(reassociated))
      if (refChild || plainChild) {
        expect(refChild?.replace("(((char_length(child_name) >= 1) AND (char_length(child_name) <= 60)) AND", "((char_length(child_name) >= 1) AND (char_length(child_name) <= 60) AND")).toBe(plainChild)
      }
      const rest = (rows: string[]) => rows.filter((c) => !c.startsWith(reassociated))
      expect(rest(d.onlyInPlain).every((c) => /^(user_identities|schema_migrations) /.test(c))).toBe(true)
      expect(rest(d.onlyInSupabase)).toEqual(["users users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE"])
    })

    it("indexes: identical", async () => {
      const d = diff(await catalog(DB, "indexes"), await catalog(REF, "indexes"))
      expect(d.onlyInPlain.every((c) => /^(user_identities|schema_migrations)_/.test(c))).toBe(true)
      expect(d.onlyInSupabase).toEqual([])
    })

    it("triggers: identical, plus the append-only guards", async () => {
      const d = diff(await catalog(DB, "triggers"), await catalog(REF, "triggers"))
      expect(d.onlyInSupabase).toEqual([])
      expect(d.onlyInPlain.map((t) => /TRIGGER (\w+)/.exec(t)?.[1]).sort()).toEqual([
        "audit_logs_append_only", "audit_logs_truncate_block",
        "moderation_logs_append_only", "moderation_logs_truncate_block",
        "parent_welcome_credit_usages_append_only", "parent_welcome_credit_usages_truncate_block",
      ])
    })

    it("functions: every difference is one of the documented ports, renames or removals", async () => {
      const plain = await catalog(DB, "functions")
      const ref = await catalog(REF, "functions")
      const d = diff(plain, ref)

      // Dropped: Supabase Auth / Storage / session helpers and superseded legacy RPCs.
      const dropped = [
        "complete_candy_purchase", "create_parent_request", "current_parent_profile_id",
        "get_current_parent_session_policy", "handle_new_user", "is_admin",
        "is_admin_or_super_admin", "is_parent", "is_parent_approved_final_deliverable", "is_super_admin",
      ]
      // Renamed to explicit-actor *_trusted variants.
      const renamed: Record<string, string> = {
        bind_current_parent_referral_code: "bind_parent_referral_code_trusted",
        get_current_parent_referral_summary: "get_parent_referral_summary_trusted",
        get_admin_referral_overview: "get_admin_referral_overview_trusted",
        get_admin_referral_relationships: "get_admin_referral_relationships_trusted",
        update_admin_referral_program_settings: "update_admin_referral_program_settings_trusted",
        get_order_status_history_admin: "get_order_status_history_admin_trusted",
        get_parent_order_status_history: "get_parent_order_status_history_trusted",
        get_parent_orders_delivered_at: "get_parent_orders_delivered_at_trusted",
      }
      // Same name, body changed: storage lookup replaced by the backend contract,
      // pgcrypto call re-qualified, or a comment inside the body reworded.
      const modified = [
        "create_parent_request_trusted", "record_final_media_trusted", "generate_parent_referral_code",
        "record_homepage_media_replacement_trusted", "update_homepage_content_trusted", "update_order_status_trusted",
      ]

      expect([...new Set(d.onlyInSupabase.map(fnName))].sort()).toEqual(
        [...dropped, ...Object.keys(renamed), ...modified].sort(),
      )
      expect([...new Set(d.onlyInPlain.map(fnName))].sort()).toEqual(
        [...Object.values(renamed), ...modified, "append_only_guard"].sort(),
      )
      // Every other function body is byte-identical (same md5 of prosrc).
      const unchanged = ref.filter((r) => !d.onlyInSupabase.includes(r))
      expect(unchanged.length).toBeGreaterThanOrEqual(20)
    })
  })

  describe("C. constraints", () => {
    it("a wallet balance can never be negative", async () => {
      const p = await createParent()
      const r = await attempt(`update public.candy_wallets set balance = -1 where parent_id='${p.profileId}'`)
      expect(r.ok).toBe(false)
      expect(r.err).toMatch(/check constraint/i)
    })

    it("welcome credits cannot be overspent or go negative", async () => {
      const p = await createParent()
      expect((await attempt(`update public.parent_welcome_credits set used_count = 4 where parent_id='${p.profileId}'`)).ok).toBe(false)
      expect((await attempt(`update public.parent_welcome_credits set used_count = -1 where parent_id='${p.profileId}'`)).ok).toBe(false)
      expect((await attempt(`insert into public.parent_welcome_credits (parent_id) values ('${p.profileId}')`)).err).toMatch(/duplicate key|unique/i)
    })

    it("one profile per user; orders need a real parent and character", async () => {
      const p = await createParent()
      expect((await attempt(`insert into public.parent_profiles (user_id) values ('${p.userId}')`)).ok).toBe(false)
      const orphan = await attempt(`insert into public.orders (parent_id, type, status, candy_cost) values ('${uuid()}', 'image', 'pending_review', 1)`)
      expect(orphan.err).toMatch(/foreign key/i)
    })

    it("an external identity maps to exactly one user", async () => {
      const a = await createUser()
      const b = await createUser()
      await psql(`insert into public.user_identities (user_id, provider, provider_subject) values ('${a}', 'supabase', '${a}')`)
      const dup = await attempt(`insert into public.user_identities (user_id, provider, provider_subject) values ('${b}', 'supabase', '${a}')`)
      expect(dup.err).toMatch(/user_identities_provider_subject_key/)
    })

    it("users get a generated id; an explicit (migrated) id is kept as given", async () => {
      expect(await createUser()).toMatch(/^[0-9a-f-]{36}$/)
      const fixed = uuid()
      expect(await psql(`insert into public.users (id, email) values ('${fixed}', 'm@x.test') returning id`)).toBe(fixed)
    })

    it("a new parent profile gets its wallet, welcome credits and referral code from triggers", async () => {
      const p = await createParent()
      expect(await balance(p)).toBe(0)
      expect(await credits(p)).toBe("3,0")
      expect(await psql(`select referral_code ~ '^CT[0-9A-F]{12}$' from public.parent_profiles where id='${p.profileId}'`)).toBe("t")
    })
  })

  describe("D/E. request creation, candy debit and welcome credits", () => {
    it("images 1-3 use a welcome credit (even with 0 candy); the 4th falls back to candy", async () => {
      const p = await createParent({ candy: 12 })
      const r = [await submit(p), await submit(p), await submit(p)]
      for (const x of r) expect(x).toMatchObject({ ok: true, source: "welcome_image_credit", cost: 0, replayed: false })
      expect(await balance(p)).toBe(12)
      expect(await submit(p)).toMatchObject({ ok: true, source: "candy", cost: 12 })
      expect(await balance(p)).toBe(0)
      expect(await credits(p)).toBe("3,3")
    })

    it("credit use writes a usage row and no candy ledger row", async () => {
      const p = await createParent()
      const r = await submit(p)
      expect(r).toMatchObject({ ok: true, source: "welcome_image_credit" })
      expect(await ledgerCount(p)).toBe(0)
      expect(await usageCount(p)).toBe(1)
    })

    it("a candy-paid order debits the wallet and appends exactly one ledger row", async () => {
      const p = await createParent({ candy: 30 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      expect(await submit(p)).toMatchObject({ ok: true, source: "candy", cost: 12 })
      expect(await balance(p)).toBe(18)
      expect(await psql(`select type||','||amount from public.candy_transactions t join public.candy_wallets w on w.id=t.wallet_id where w.parent_id='${p.profileId}'`)).toBe("order_debit,-12")
    })

    it("video and drawing animation never use credits and pay candy at catalog prices", async () => {
      const p = await createParent({ candy: 100 })
      expect(await submit(p, { type: "video" })).toMatchObject({ ok: true, source: "candy", cost: 40 })
      expect(await submit(p, { type: "drawing_animation" })).toMatchObject({ ok: true, source: "candy", cost: 35 })
      expect(await credits(p)).toBe("3,0")
      expect(await balance(p)).toBe(25)
    })

    it("insufficient candy creates nothing and moves nothing", async () => {
      const p = await createParent({ candy: 5 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      expect(await submit(p)).toMatchObject({ ok: false, error: "INSUFFICIENT_CANDIES" })
      expect(await orderCount(p)).toBe(0)
      expect(await balance(p)).toBe(5)
    })

    it("the database refuses a welcome-credit video order", async () => {
      const p = await createParent({ candy: 100 })
      const v = await submit(p, { type: "video" })
      const bad = await attempt(`update public.orders set payment_source='welcome_image_credit' where id='${v.id}'`)
      expect(bad.err).toMatch(/check constraint/i)
    })

    it("admins cannot create parent requests", async () => {
      const p = await createParent({ candy: 100 })
      await psql(`update public.users set role='admin' where id='${p.userId}'`)
      expect(await submit(p)).toMatchObject({ ok: false, error: "request_parent_required" })
    })
  })

  describe("source-file contract (storage checks moved to the backend)", () => {
    it("a verified source file is recorded with the MIME type the backend supplied", async () => {
      const p = await createParent({ candy: 100 })
      const r = await submit(p, { type: "drawing_animation", mime: "image/webp" })
      expect(r.ok).toBe(true)
      expect(await psql(`select type||','||mime_type||','||(file_url like '${p.userId}/%') from public.media_assets where order_id='${r.id}'`)).toBe("upload,image/webp,true")
    })

    it("no verified metadata => request_file_not_found, nothing created", async () => {
      const p = await createParent({ candy: 100 })
      expect(await submit(p, { type: "drawing_animation", mime: null })).toMatchObject({ ok: false, error: "request_file_not_found" })
      expect(await orderCount(p)).toBe(0)
      expect(await balance(p)).toBe(100)
    })

    it("a non-image MIME type is still refused by the database", async () => {
      const p = await createParent({ candy: 100 })
      expect(await submit(p, { type: "drawing_animation", mime: "application/pdf" })).toMatchObject({ ok: false, error: "request_file_type_invalid" })
    })

    it("a path outside <user>/<order>/ is still refused - ownership stays enforced in SQL", async () => {
      const p = await createParent({ candy: 100 })
      const other = await createParent()
      const orderId = uuid()
      for (const filePath of [`${other.userId}/${orderId}/x.png`, `/abs/${orderId}.png`, `${p.userId}/${orderId}/../x.png`]) {
        expect(await submit(p, { type: "drawing_animation", orderId, filePath })).toMatchObject({ ok: false, error: "request_invalid_file_path" })
      }
    })
  })

  describe("F/G. idempotency and concurrency (genuinely concurrent sessions)", () => {
    it("the same submission key replayed sequentially returns the same order", async () => {
      const p = await createParent()
      const key = uuid()
      const a = await submit(p, { key })
      const b = await submit(p, { key })
      expect(b).toMatchObject({ ok: true, id: a.id, replayed: true, source: "welcome_image_credit" })
      expect(await orderCount(p)).toBe(1)
    })

    it("same key x10 concurrently: one order, one credit, nine replays", async () => {
      const p = await createParent()
      const key = uuid()
      const results = await submitMany(p, 10, () => ({ key }))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(new Set(results.map((r) => r.id)).size).toBe(1)
      expect(results.filter((r) => r.replayed === false)).toHaveLength(1)
      expect(await orderCount(p)).toBe(1)
      expect(await credits(p)).toBe("3,1")
      expect(await usageCount(p)).toBe(1)
    })

    it("same key x10 on the candy path: exactly one debit and one ledger row", async () => {
      const p = await createParent({ candy: 12 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      const key = uuid()
      const results = await submitMany(p, 10, () => ({ key }))
      expect(results.every((r) => r.ok)).toBe(true)
      expect(await balance(p)).toBe(0)
      expect(await ledgerCount(p)).toBe(1)
      expect(await orderCount(p)).toBe(1)
    })

    it("5 concurrent unique image requests, 3 credits, 0 candy: exactly 3 succeed", async () => {
      const p = await createParent()
      const results = await submitMany(p, 5)
      expect(results.filter((r) => r.ok)).toHaveLength(3)
      expect(results.filter((r) => r.error === "INSUFFICIENT_CANDIES")).toHaveLength(2)
      expect(await credits(p)).toBe("3,3")
      expect(await orderCount(p)).toBe(3)
    })

    it("H. 8 concurrent candy requests for a balance of 3: never overdrawn", async () => {
      const p = await createParent({ candy: 36 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      const results = await submitMany(p, 8)
      expect(results.filter((r) => r.ok)).toHaveLength(3)
      // Losers wait on the wallet lock and then fail cleanly. Without the lock
      // they would hit the balance CHECK instead - still no overdraft, but a
      // raw constraint error reaching the caller.
      expect(results.filter((r) => r.error === "INSUFFICIENT_CANDIES")).toHaveLength(5)
      expect(await balance(p)).toBe(0)
      expect(await ledgerCount(p)).toBe(3)
      expect(Number(await psql(`select coalesce(sum(-amount),0) from public.candy_transactions t join public.candy_wallets w on w.id=t.wallet_id where w.parent_id='${p.profileId}'`))).toBe(36)
    })

    it("concurrent profile creation for one user: exactly one profile, one grant", async () => {
      const userId = await createUser()
      const results = await runSimultaneously(
        Array.from({ length: 8 }, () => `insert into public.parent_profiles (user_id, consent_granted) values ('${userId}', true)`),
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(await psql(`select count(*) from public.parent_welcome_credits c join public.parent_profiles pp on pp.id=c.parent_id where pp.user_id='${userId}'`)).toBe("1")
    })
  })

  describe("I. order status workflow and append-only history", () => {
    async function admin(): Promise<string> {
      return createUser("admin")
    }
    const stamp = (orderId: string) => psql(`select updated_at from public.orders where id='${orderId}'`)
    const move = async (adminId: string, orderId: string, status: string) =>
      attempt(`select new_status from public.update_order_status_trusted('${orderId}', '${adminId}', '${status}', '${await stamp(orderId)}', 'n', null)`)

    it("full delivery flow through the ported final-media functions", async () => {
      const a = await admin()
      const p = await createParent({ candy: 100 })
      const o = await submit(p)
      expect((await move(a, o.id!, "in_progress")).out).toBe("in_progress")
      expect((await move(a, o.id!, "ready")).err).toMatch(/request_final_media_required/)

      const asset = await psql(`select asset_id from public.record_final_media_trusted('${a}', '${o.id}', 'orders/${o.id}/final/out.png', 'image/png', 1234, 'out.png')`)
      expect((await attempt(`select 1 from public.record_final_media_trusted('${a}', '${o.id}', 'orders/${o.id}/final/b.png', null, 1, 'b')`)).err).toMatch(/request_file_invalid/)
      expect((await attempt(`select 1 from public.record_final_media_trusted('${a}', '${o.id}', 'orders/${uuid()}/final/c.png', 'image/png', 1, 'c')`)).err).toMatch(/request_invalid_path/)
      await psql(`select 1 from public.approve_final_media_trusted('${a}', '${asset}', '${o.id}')`)

      expect((await move(a, o.id!, "ready")).out).toBe("ready")
      expect((await move(a, o.id!, "delivered")).out).toBe("delivered")
      expect(await psql(`select string_agg(new_status, '>' order by created_at) from public.order_status_history where order_id='${o.id}'`)).toBe("in_progress>ready>delivered")

      const delivered = await psql(`select count(*) from public.get_parent_orders_delivered_at_trusted('${p.profileId}', array['${o.id}']::uuid[])`)
      expect(delivered).toBe("1")
      const otherParent = await createParent()
      expect(await psql(`select count(*) from public.get_parent_orders_delivered_at_trusted('${otherParent.profileId}', array['${o.id}']::uuid[])`)).toBe("0")
    })

    it("history rows cannot be updated, deleted or truncated; an order delete cascades", async () => {
      const a = await admin()
      const p = await createParent({ candy: 100 })
      const o = await submit(p)
      await move(a, o.id!, "in_progress")
      expect((await attempt(`update public.order_status_history set new_status='x' where order_id='${o.id}'`)).err).toMatch(/order_status_history_append_only/)
      expect((await attempt(`delete from public.order_status_history where order_id='${o.id}'`)).err).toMatch(/order_status_history_append_only/)
      expect((await attempt(`truncate public.order_status_history`)).err).toMatch(/order_status_history_append_only/)
      expect((await attempt(`delete from public.orders where id='${o.id}'`)).ok).toBe(true)
    })

    it("two admins moving one order concurrently: exactly one wins, the other conflicts", async () => {
      const a = await admin()
      const p = await createParent({ candy: 100 })
      const o = await submit(p)
      const at = await stamp(o.id!)
      const sql = (s: string) => `select new_status from public.update_order_status_trusted('${o.id}', '${a}', '${s}', '${at}', 'n', null)`
      const results = await runSimultaneously([sql("in_progress"), sql("cancelled"), sql("in_progress"), sql("rejected")])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => /request_status_conflict/.test(r.err))).toHaveLength(3)
      expect(await psql(`select count(*) from public.order_status_history where order_id='${o.id}'`)).toBe("1")
    })

    it("explicit-actor history reads keep their ownership and role checks", async () => {
      const a = await admin()
      const p = await createParent({ candy: 100 })
      const stranger = await createParent()
      const o = await submit(p)
      await move(a, o.id!, "in_progress")
      expect(await psql(`select count(*) from public.get_parent_order_status_history_trusted('${p.profileId}', '${o.id}')`)).toBe("1")
      expect((await attempt(`select * from public.get_parent_order_status_history_trusted('${stranger.profileId}', '${o.id}')`)).err).toMatch(/request_forbidden/)
      expect(await psql(`select count(*) from public.get_order_status_history_admin_trusted('${a}', '${o.id}')`)).toBe("1")
      expect((await attempt(`select * from public.get_order_status_history_admin_trusted('${p.userId}', '${o.id}')`)).err).toMatch(/request_forbidden/)
    })
  })

  describe("J. audit and ledger protections", () => {
    it("candy_transactions is append-only", async () => {
      const p = await createParent({ candy: 30 })
      await psql(`update public.parent_welcome_credits set used_count = granted_count where parent_id='${p.profileId}'`)
      await submit(p)
      const where = `wallet_id in (select id from public.candy_wallets where parent_id='${p.profileId}')`
      expect((await attempt(`update public.candy_transactions set amount = 0 where ${where}`)).err).toMatch(/append-only/)
      expect((await attempt(`delete from public.candy_transactions where ${where}`)).err).toMatch(/append-only/)
    })

    it("audit_logs and moderation_logs are append-only (new guard)", async () => {
      const auditId = await psql(`insert into public.audit_logs (action, target_type, target_id) values ('x', 'order', '${uuid()}') returning id`)
      expect((await attempt(`update public.audit_logs set action='y' where id='${auditId}'`)).err).toMatch(/audit_logs_append_only/)
      expect((await attempt(`delete from public.audit_logs where id='${auditId}'`)).err).toMatch(/audit_logs_append_only/)
      expect((await attempt(`truncate public.audit_logs`)).err).toMatch(/audit_logs_append_only/)
      expect((await attempt(`truncate public.moderation_logs`)).err).toMatch(/moderation_logs_append_only/)
    })

    it("welcome-credit usage records are append-only, but cascade with their order", async () => {
      const p = await createParent()
      const r = await submit(p)
      expect((await attempt(`update public.parent_welcome_credit_usages set order_id=order_id where order_id='${r.id}'`)).err).toMatch(/parent_welcome_credit_usages_append_only/)
      expect((await attempt(`delete from public.parent_welcome_credit_usages where order_id='${r.id}'`)).err).toMatch(/parent_welcome_credit_usages_append_only/)
      expect((await attempt(`delete from public.orders where id='${r.id}'`)).ok).toBe(true)
      expect(await usageCount(p)).toBe(0)
    })

    it("referral settings history is immutable", async () => {
      const a = await createUser("admin")
      const at = await psql("select updated_at from public.referral_program_settings where id=1")
      const enabled = await psql("select is_enabled from public.referral_program_settings where id=1")
      const flipped = enabled === "t" ? "false" : "true"
      expect(await psql(`select status from public.update_admin_referral_program_settings_trusted('${a}', ${flipped}, 500, '${at}')`)).toBe("updated")
      expect((await attempt("update public.referral_program_settings_history set new_reward_basis_points = 1")).err).toMatch(/immutable/)
      expect((await attempt("delete from public.referral_program_settings_history")).err).toMatch(/immutable/)
    })
  })

  describe("K. optimistic concurrency", () => {
    it("coupon edits: concurrent updates from the same snapshot - exactly one applies", async () => {
      const a = await createUser("admin")
      const code = `C${id.slice(-6).toUpperCase()}`
      const couponId = await psql(`select coupon_id from public.create_coupon_trusted('${a}', '${code}', 'n', null, 'percentage', 10, true, null, null, null, null, null, null, null)`)
      const at = await psql(`select updated_at from public.coupons where id='${couponId}'`)
      const upd = (name: string) => `select coupon_id from public.update_coupon_trusted('${a}', '${couponId}', '${at}', '${code}', '${name}', null, 'percentage', 10, true, null, null, null, null, null, null, null)`
      const results = await runSimultaneously([upd("a"), upd("b"), upd("c"), upd("d")])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => /coupon_admin_conflict/.test(r.err))).toHaveLength(3)
    })

    it("a non-admin cannot create coupons", async () => {
      const p = await createParent()
      const r = await attempt(`select * from public.create_coupon_trusted('${p.userId}', 'NOPE123', 'n', null, 'percentage', 10, true, null, null, null, null, null, null, null)`)
      expect(r.ok).toBe(false)
    })

    it("referral settings: a stale snapshot is a conflict, not an overwrite", async () => {
      const a = await createUser("admin")
      const r = await psql(`select status from public.update_admin_referral_program_settings_trusted('${a}', true, 100, '2000-01-01T00:00:00Z')`)
      expect(r).toBe("conflict")
      const parent = await createParent()
      expect(await psql(`select status from public.update_admin_referral_program_settings_trusted('${parent.userId}', true, 100, now())`)).toBe("forbidden")
    })
  })

  describe("explicit-actor referral functions", () => {
    it("binding: a parent binds another parent's code once; self-referral is refused", async () => {
      const a = await createUser("admin")
      const at = await psql("select updated_at from public.referral_program_settings where id=1")
      await psql(`select status from public.update_admin_referral_program_settings_trusted('${a}', true, (select reward_basis_points from public.referral_program_settings where id=1), '${at}')`)
      if ((await psql("select is_enabled from public.referral_program_settings where id=1")) !== "t") {
        const at2 = await psql("select updated_at from public.referral_program_settings where id=1")
        await psql(`select status from public.update_admin_referral_program_settings_trusted('${a}', true, 100, '${at2}')`)
      }
      const referrer = await createParent()
      const referred = await createParent()
      const code = await psql(`select referral_code from public.parent_profiles where id='${referrer.profileId}'`)
      const own = await psql(`select referral_code from public.parent_profiles where id='${referred.profileId}'`)
      expect(await psql(`select status from public.bind_parent_referral_code_trusted('${referred.userId}', '${own}')`)).toBe("invalid_code")
      expect(await psql(`select status from public.bind_parent_referral_code_trusted('${referred.userId}', '${code}')`)).toBe("bound")
      expect(await psql(`select status from public.bind_parent_referral_code_trusted('${referred.userId}', '${code}')`)).toBe("already_bound_same")
      expect(await psql(`select referred_count from public.get_parent_referral_summary_trusted('${referrer.userId}')`)).toBe("1")
      expect(await psql(`select status from public.bind_parent_referral_code_trusted(null, '${code}')`)).toBe("session_expired")
    })

    it("admin referral reads return nothing for a non-admin", async () => {
      const p = await createParent()
      expect(await psql(`select count(*) from public.get_admin_referral_overview_trusted('${p.userId}')`)).toBe("0")
      const a = await createUser("admin")
      expect(await psql(`select count(*) from public.get_admin_referral_overview_trusted('${a}')`)).toBe("1")
    })
  })
})

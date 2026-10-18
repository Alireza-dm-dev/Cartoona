/**
 * Integrity and reconciliation checks (V0.1.44).
 *
 * Source and target share the `public` table shape, so the SAME SQL runs on
 * both: on the source BEFORE anything is written (a broken source is refused
 * with zero target writes), and on the target after the copy. Nothing here
 * writes or repairs; a violation is reported with up to 10 sample references
 * (ids and amounts only, never emails, names or tokens).
 *
 * The business rules are the ones the schema actually implements:
 *  - candy: every balance change writes a signed ledger row in the same
 *    transaction (complete_candy_purchase_trusted: +candy_amount 'purchase',
 *    key 'purchase_credit:<purchase>'; create_parent_request_trusted:
 *    -candy_cost 'order_debit', key 'order_debit:<order>'). So
 *    balance = SUM(amount) per wallet is the invariant, and each debit/credit
 *    must match the order/purchase it references.
 *  - welcome credits: used_count is incremented in the same statement block
 *    that inserts exactly one usage row (create_parent_request_trusted), so
 *    used_count = COUNT(usages) and every credit-paid order is an image order
 *    with candy_cost 0 and exactly one usage.
 */

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>
}

export type Severity = "error" | "warning"
export type Side = "source" | "target"

export interface CheckResult {
  check: string
  severity: Severity
  count: number
  sample: string[]
}

interface Check {
  name: string
  severity: Severity
  side: Side | "both"
  sql: string
}

const CHECKS: Check[] = [
  // ── uniqueness the target enforces; a dump restored without constraints may not ──
  { name: "duplicate_profile_per_user", severity: "error", side: "both", sql: `SELECT user_id::text AS ref FROM public.parent_profiles GROUP BY user_id HAVING count(*) > 1` },
  { name: "duplicate_wallet_per_parent", severity: "error", side: "both", sql: `SELECT parent_id::text AS ref FROM public.candy_wallets GROUP BY parent_id HAVING count(*) > 1` },
  { name: "duplicate_submission_key", severity: "error", side: "both", sql: `SELECT parent_id::text || ' submission_key=' || submission_key AS ref FROM public.orders WHERE submission_key IS NOT NULL GROUP BY parent_id, submission_key HAVING count(*) > 1` },
  { name: "duplicate_ledger_idempotency_key", severity: "error", side: "both", sql: `SELECT idempotency_key AS ref FROM public.candy_transactions WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*) > 1` },
  { name: "duplicate_referral_code", severity: "error", side: "both", sql: `SELECT referral_code AS ref FROM public.parent_profiles GROUP BY referral_code HAVING count(*) > 1` },

  // ── candy wallet reconciliation ──
  {
    name: "wallet_balance_mismatch",
    severity: "error",
    side: "both",
    sql: `SELECT 'parent_profile=' || w.parent_id || ' wallet=' || w.id || ' balance=' || w.balance || ' ledger_sum=' || coalesce(s.total, 0) AS ref
          FROM public.candy_wallets w
          LEFT JOIN (SELECT wallet_id, sum(amount)::bigint AS total FROM public.candy_transactions GROUP BY wallet_id) s ON s.wallet_id = w.id
          WHERE w.balance <> coalesce(s.total, 0)`,
  },
  { name: "wallet_negative_balance", severity: "error", side: "both", sql: `SELECT 'parent_profile=' || parent_id || ' balance=' || balance AS ref FROM public.candy_wallets WHERE balance < 0` },
  {
    name: "ledger_sign_invalid",
    severity: "error",
    side: "both",
    sql: `SELECT id::text || ' type=' || type || ' amount=' || amount AS ref FROM public.candy_transactions
          WHERE (type IN ('purchase', 'refund', 'grant') AND amount <= 0) OR (type IN ('order_debit', 'spend') AND amount >= 0)`,
  },
  {
    name: "ledger_order_debit_unmatched",
    severity: "error",
    side: "both",
    sql: `SELECT t.id::text || ' order=' || coalesce(t.reference_id, '?') AS ref
          FROM public.candy_transactions t JOIN public.candy_wallets w ON w.id = t.wallet_id
          WHERE t.type = 'order_debit' AND NOT EXISTS (
            SELECT 1 FROM public.orders o
            WHERE t.reference_type = 'order' AND o.id::text = t.reference_id AND o.parent_id = w.parent_id
              AND o.payment_source = 'candy' AND t.amount = -o.candy_cost)`,
  },
  {
    name: "candy_order_debit_count",
    severity: "error",
    side: "both",
    sql: `SELECT 'order=' || o.id || ' debits=' || coalesce(d.n, 0) AS ref
          FROM public.orders o
          LEFT JOIN (SELECT reference_id, count(*) AS n FROM public.candy_transactions
                     WHERE type = 'order_debit' AND reference_type = 'order' GROUP BY reference_id) d ON d.reference_id = o.id::text
          WHERE o.payment_source = 'candy' AND o.candy_cost > 0 AND coalesce(d.n, 0) <> 1`,
  },
  {
    name: "ledger_purchase_unmatched",
    severity: "error",
    side: "both",
    sql: `SELECT t.id::text || ' purchase=' || coalesce(t.reference_id, '?') AS ref
          FROM public.candy_transactions t JOIN public.candy_wallets w ON w.id = t.wallet_id
          WHERE t.type = 'purchase' AND NOT EXISTS (
            SELECT 1 FROM public.candy_purchases p
            WHERE t.reference_type = 'candy_purchase' AND p.id::text = t.reference_id AND p.parent_id = w.parent_id
              AND p.status = 'paid' AND t.amount = p.candy_amount)`,
  },
  {
    name: "paid_purchase_credit_count",
    severity: "error",
    side: "both",
    sql: `SELECT 'purchase=' || p.id || ' credits=' || coalesce(c.n, 0) AS ref
          FROM public.candy_purchases p
          LEFT JOIN (SELECT reference_id, count(*) AS n FROM public.candy_transactions
                     WHERE type = 'purchase' AND reference_type = 'candy_purchase' GROUP BY reference_id) c ON c.reference_id = p.id::text
          WHERE p.status = 'paid' AND coalesce(c.n, 0) <> 1`,
  },

  // ── welcome image credits ──
  { name: "welcome_used_exceeds_granted", severity: "error", side: "both", sql: `SELECT 'parent_profile=' || parent_id || ' granted=' || granted_count || ' used=' || used_count AS ref FROM public.parent_welcome_credits WHERE used_count > granted_count OR used_count < 0 OR granted_count <= 0` },
  {
    name: "welcome_used_count_mismatch",
    severity: "error",
    side: "both",
    sql: `SELECT 'parent_profile=' || c.parent_id || ' used_count=' || c.used_count || ' usages=' || coalesce(u.n, 0) AS ref
          FROM public.parent_welcome_credits c
          LEFT JOIN (SELECT parent_id, count(*) AS n FROM public.parent_welcome_credit_usages GROUP BY parent_id) u ON u.parent_id = c.parent_id
          WHERE c.used_count <> coalesce(u.n, 0)`,
  },
  {
    name: "welcome_usage_order_invalid",
    severity: "error",
    side: "both",
    sql: `SELECT 'usage=' || u.id || ' order=' || u.order_id AS ref
          FROM public.parent_welcome_credit_usages u JOIN public.orders o ON o.id = u.order_id
          WHERE o.parent_id <> u.parent_id OR o.type <> 'image' OR o.payment_source <> 'welcome_image_credit' OR o.candy_cost <> 0`,
  },
  {
    name: "welcome_order_usage_count",
    severity: "error",
    side: "both",
    sql: `SELECT 'order=' || o.id || ' usages=' || coalesce(u.n, 0) AS ref
          FROM public.orders o
          LEFT JOIN (SELECT order_id, count(*) AS n FROM public.parent_welcome_credit_usages GROUP BY order_id) u ON u.order_id = o.id
          WHERE o.payment_source = 'welcome_image_credit' AND coalesce(u.n, 0) <> 1`,
  },

  // ── orders ──
  {
    name: "order_payment_source_invalid",
    severity: "error",
    side: "both",
    sql: `SELECT 'order=' || id || ' payment_source=' || coalesce(payment_source, 'NULL') AS ref FROM public.orders
          WHERE payment_source IS NULL OR payment_source NOT IN ('candy', 'welcome_image_credit') OR (payment_source = 'welcome_image_credit' AND type <> 'image')`,
  },

  // ── media keys (reported; copied verbatim either way) ──
  {
    name: "media_upload_key_prefix",
    severity: "warning",
    side: "both",
    sql: `SELECT 'media=' || m.id AS ref
          FROM public.media_assets m JOIN public.orders o ON o.id = m.order_id JOIN public.parent_profiles p ON p.id = o.parent_id
          WHERE m.type = 'upload' AND m.file_url NOT LIKE p.user_id::text || '/' || o.id::text || '/%'`,
  },
  { name: "media_final_key_prefix", severity: "warning", side: "both", sql: `SELECT 'media=' || id AS ref FROM public.media_assets WHERE asset_role = 'final' AND file_url NOT LIKE 'orders/' || order_id::text || '/final/%'` },

  // ── account defaults (reported) ──
  { name: "parent_without_wallet", severity: "warning", side: "both", sql: `SELECT 'parent_profile=' || p.id AS ref FROM public.parent_profiles p WHERE NOT EXISTS (SELECT 1 FROM public.candy_wallets w WHERE w.parent_id = p.id)` },
  {
    name: "active_parent_without_welcome_grant",
    severity: "warning",
    side: "both",
    sql: `SELECT 'parent_profile=' || p.id AS ref FROM public.parent_profiles p JOIN public.users u ON u.id = p.user_id
          WHERE u.role = 'parent' AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.parent_welcome_credits c WHERE c.parent_id = p.id)`,
  },

  // ── singletons the application needs ──
  {
    name: "required_singleton_missing",
    severity: "error",
    side: "both",
    sql: `SELECT 'referral_program_settings' AS ref WHERE (SELECT count(*) FROM public.referral_program_settings WHERE id = 1) <> 1
          UNION ALL SELECT 'homepage_content' WHERE (SELECT count(*) FROM public.homepage_content) <> 1
          UNION ALL SELECT 'homepage_hero_layout' WHERE (SELECT count(*) FROM public.homepage_hero_layout) <> 1`,
  },

  // ── target only: identity backfill, session column, triggers ──
  {
    name: "identity_missing",
    severity: "error",
    side: "target",
    sql: `SELECT 'user=' || u.id AS ref FROM public.users u
          WHERE NOT EXISTS (SELECT 1 FROM public.user_identities i WHERE i.provider = 'supabase' AND i.provider_subject = u.id::text AND i.user_id = u.id)`,
  },
  { name: "identity_conflict", severity: "error", side: "target", sql: `SELECT 'identity=' || id || ' user=' || user_id AS ref FROM public.user_identities WHERE provider = 'supabase' AND provider_subject <> user_id::text` },
  { name: "sessions_not_before_set", severity: "error", side: "target", sql: `SELECT 'user=' || id AS ref FROM public.users WHERE sessions_not_before IS NOT NULL` },
  {
    name: "trigger_not_enabled",
    severity: "error",
    side: "target",
    sql: `SELECT c.relname || '.' || t.tgname AS ref FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'O'`,
  },
]

export interface ForeignKey {
  name: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
}

/** Every foreign key of the plain schema, read from the target catalog. */
export async function readForeignKeys(target: Queryable): Promise<ForeignKey[]> {
  const { rows } = await target.query<{ name: string; tbl: string; cols: string[]; ref_tbl: string; ref_cols: string[] }>(`
    SELECT c.conname AS name, cl.relname AS tbl, rc.relname AS ref_tbl,
           array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS cols,
           array(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS ref_cols
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class rc ON rc.oid = c.confrelid
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND rc.relnamespace = 'public'::regnamespace
    ORDER BY c.conname`)
  return rows.map((r) => ({ name: r.name, table: r.tbl, columns: r.cols, refTable: r.ref_tbl, refColumns: r.ref_cols }))
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

function orphanSql(fk: ForeignKey): string {
  const notNull = fk.columns.map((c) => `c.${ident(c)} IS NOT NULL`).join(" AND ")
  const match = fk.columns.map((c, i) => `p.${ident(fk.refColumns[i])} = c.${ident(c)}`).join(" AND ")
  const ref = fk.columns.map((c) => `c.${ident(c)}::text`).join(" || '/' || ")
  return `SELECT ${ref} AS ref FROM public.${ident(fk.table)} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM public.${ident(fk.refTable)} p WHERE ${match})`
}

async function runOne(db: Queryable, name: string, severity: Severity, sql: string): Promise<CheckResult> {
  const { rows } = await db.query<{ n: number; sample: string[] | null }>(
    `SELECT count(*)::int AS n, (array_agg(ref ORDER BY ref))[1:10] AS sample FROM (${sql}) x`,
  )
  return { check: name, severity, count: rows[0]?.n ?? 0, sample: rows[0]?.sample ?? [] }
}

/**
 * Run every check that applies to `side`. Foreign keys come from the target
 * catalog; on the source, a key whose table only exists in the plain schema
 * (user_identities) is skipped.
 */
export async function runChecks(db: Queryable, side: Side, foreignKeys: ForeignKey[], existingTables: Set<string>): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const fk of foreignKeys) {
    if (!existingTables.has(fk.table) || !existingTables.has(fk.refTable)) continue
    results.push(await runOne(db, `fk_orphan:${fk.table}.${fk.columns.join(",")}->${fk.refTable}`, "error", orphanSql(fk)))
  }
  for (const check of CHECKS) {
    if (check.side !== "both" && check.side !== side) continue
    results.push(await runOne(db, check.name, check.severity, check.sql))
  }
  return results
}

export const failures = (results: CheckResult[]) => results.filter((r) => r.severity === "error" && r.count > 0)
export const warnings = (results: CheckResult[]) => results.filter((r) => r.severity === "warning" && r.count > 0)

/** Manifest form: names and counts only, no sample references. */
export const summarize = (results: CheckResult[]) => ({
  checks: results.length,
  errors: failures(results).map((r) => ({ check: r.check, count: r.count })),
  warnings: warnings(results).map((r) => ({ check: r.check, count: r.count })),
})

export const CHECK_NAMES = CHECKS.map((c) => c.name)

/**
 * Canonical Supabase -> plain PostgreSQL data mapping (V0.1.44).
 *
 * The plain schema (database/migrations 0001-0015) is column-identical to the
 * migrated Supabase `public` schema for every domain table (proven by the
 * parity suite in tests/unit/plain-postgres-db.test.ts), except:
 *   - users.sessions_not_before   target-only (V0.1.43), always NULL on copy
 *   - user_identities             target-only, derived from users.id
 *   - users.id -> auth.users FK   source-only, not carried over
 *   - internal_write_nonces       target-only (V0.1.47), never copied, starts empty
 *
 * 0014 (V0.1.48) adds only a function (record_parent_consent_trusted) and its
 * EXECUTE grant: no table or column, so nothing here changed. Consent
 * (parent_profiles.consent_granted / consent_granted_at) was already copied
 * verbatim and stays so: copied values are never regenerated.
 *
 * 0015 (V0.1.49) adds only a function (provision_supabase_parent_identity)
 * and its EXECUTE grant: no table or column. It provisions accounts created
 * AFTER the copy and writes exactly the row shape this mapping produces
 * (users.id = subject, the same deterministic user_identities id and
 * created_at rule, one profile + wallet + welcome-credit row), so the two
 * populations are indistinguishable except users.email (NULL when
 * provisioned; never read by the plain-PostgreSQL code).
 *
 * Every application-owned table appears exactly once below. The static suite
 * (tests/unit/data-copy-static.test.ts) fails when a table is added to the
 * plain schema without being classified here.
 */

export type Strategy =
  /** Rows copied verbatim, same ids and values. */
  | "direct"
  /** Rows copied with a documented change of shape. */
  | "transformed"
  /** Target seed rows from 0008 are deleted and replaced by the source rows, in one transaction. */
  | "reference_replace"
  /** Not copied: computed in the target from copied data. */
  | "derived"

export interface TableSpec {
  table: string
  strategy: Strategy
  /** Primary key columns, in key order - the keyset for batched reads and checksums. */
  pk: string[]
  /** Named triggers disabled for this table's insert, inside the phase transaction only. */
  bypassTriggers?: { name: string; reason: string }[]
  /** Columns the target has and the source never had. Left to their default (NULL). */
  targetOnlyColumns?: string[]
  /**
   * Columns inserted as NULL first and set in a second pass after the table
   * they reference is loaded (a foreign-key cycle).
   */
  secondPass?: { column: string; after: string; bypassTriggers: { name: string; reason: string }[] }
  notes: string
}

export interface PhaseSpec {
  name: string
  tables: TableSpec[]
}

const UPDATED_AT_BYPASS = (table: string) => ({
  name: `${table}_set_updated_at`,
  reason: "the second-pass UPDATE would otherwise overwrite the historical updated_at with now()",
})

/** Copy order. Each phase is one target transaction; a phase depends only on earlier phases. */
export const PHASES: PhaseSpec[] = [
  {
    name: "users",
    tables: [
      {
        table: "users",
        strategy: "transformed",
        pk: ["id"],
        targetOnlyColumns: ["sessions_not_before"],
        notes:
          "id preserved = Supabase auth user UUID. The FK to auth.users is not carried over. sessions_not_before is target-only and stays NULL. deleted_at copied exactly (soft-deleted accounts stay deleted).",
      },
      {
        table: "user_identities",
        strategy: "derived",
        pk: ["id"],
        notes:
          "Backfilled in the target: one ('supabase', users.id::text) row per copied user, deleted users included. Deterministic id md5('cartoona-identity:supabase:' || user id)::uuid, created_at = users.created_at.",
      },
    ],
  },
  {
    name: "reference",
    tables: [
      { table: "creation_pricing", strategy: "reference_replace", pk: ["id"], notes: "Business-edited price catalog. Source ids carried forward; seed rows replaced, never merged (pricing_key is unique)." },
      { table: "candy_packages", strategy: "reference_replace", pk: ["id"], notes: "candy_purchases.package_id and coupon_package_rules reference the SOURCE ids." },
      { table: "characters", strategy: "reference_replace", pk: ["id"], notes: "orders.character_id and examples.character_id reference the SOURCE ids." },
      { table: "referral_program_settings", strategy: "reference_replace", pk: ["id"], notes: "Singleton (id = 1). Admin-edited values carry forward." },
      { table: "homepage_content", strategy: "reference_replace", pk: ["id"], notes: "CMS singleton; revision carries forward (optimistic concurrency)." },
      { table: "homepage_hero_layout", strategy: "reference_replace", pk: ["id"], notes: "CMS singleton; revision carries forward." },
      { table: "homepage_media_assets", strategy: "direct", pk: ["id"], notes: "CMS media metadata only (storage_path). No object bytes." },
    ],
  },
  {
    name: "parents",
    tables: [
      {
        table: "parent_profiles",
        strategy: "direct",
        pk: ["id"],
        bypassTriggers: [
          { name: "assign_parent_referral_code", reason: "BEFORE INSERT: would REPLACE the historical referral_code with a new random one, breaking referral_relationships snapshots and shared links" },
          { name: "ensure_parent_candy_wallet", reason: "AFTER INSERT: would create a second, zero-balance wallet with a new id; the historical wallet (and its ledger) is copied instead" },
          { name: "grant_parent_welcome_image_credits", reason: "AFTER INSERT: would create a fresh 3/0 grant; the historical grant with its used_count is copied instead" },
        ],
        notes: "Referral codes, consent and timestamps preserved. The three INSERT triggers are bypassed for this insert only.",
      },
      { table: "candy_wallets", strategy: "direct", pk: ["id"], notes: "Wallet ids and balances preserved; reconciled against the ledger after the copy." },
      { table: "parent_welcome_credits", strategy: "direct", pk: ["parent_id"], notes: "granted_count/used_count preserved; reconciled against usages." },
      { table: "child_profiles", strategy: "direct", pk: ["id"], notes: "" },
      { table: "referral_relationships", strategy: "direct", pk: ["id"], notes: "" },
      { table: "referral_binding_rate_limits", strategy: "direct", pk: ["parent_id"], notes: "Operational anti-abuse window; copied so a short write freeze does not reset it." },
    ],
  },
  {
    name: "commerce",
    tables: [
      { table: "coupons", strategy: "direct", pk: ["id"], notes: "" },
      { table: "coupon_package_rules", strategy: "direct", pk: ["coupon_id", "package_id"], notes: "" },
      {
        table: "candy_purchases",
        strategy: "direct",
        pk: ["id"],
        secondPass: { column: "active_payment_attempt_id", after: "payment_attempts", bypassTriggers: [UPDATED_AT_BYPASS("candy_purchases")] },
        notes: "FK cycle with payment_attempts: inserted with active_payment_attempt_id NULL, set from the source after payment_attempts.",
      },
      { table: "payment_attempts", strategy: "direct", pk: ["id"], notes: "" },
      { table: "payment_webhook_events", strategy: "direct", pk: ["id"], notes: "" },
      { table: "coupon_redemptions", strategy: "direct", pk: ["id"], notes: "" },
    ],
  },
  {
    name: "orders",
    tables: [
      { table: "orders", strategy: "direct", pk: ["id"], notes: "child_name, submission_key, payment_source, created_at/updated_at preserved." },
      { table: "video_requests", strategy: "direct", pk: ["id"], notes: "Fulfilment extension row." },
      { table: "drawing_animation_requests", strategy: "direct", pk: ["id"], notes: "Fulfilment extension row." },
      { table: "order_status_history", strategy: "direct", pk: ["id"], notes: "Append-only; INSERT is not guarded, so no bypass. delivered_at is derived from these rows and therefore preserved." },
      { table: "media_assets", strategy: "direct", pk: ["id"], notes: "Metadata only: ids, file_url (object KEY), MIME, size, role, delivery/visibility flags. No object bytes." },
      { table: "parent_welcome_credit_usages", strategy: "direct", pk: ["id"], notes: "Append-only; INSERT is not guarded." },
    ],
  },
  {
    name: "ledger",
    tables: [
      { table: "candy_transactions", strategy: "direct", pk: ["id"], notes: "Append-only ledger; INSERT is not guarded. idempotency_key preserved (unique)." },
    ],
  },
  {
    name: "content_and_logs",
    tables: [
      { table: "examples", strategy: "direct", pk: ["id"], notes: "Public example CMS; media_url/thumbnail_url are object keys." },
      { table: "referral_program_settings_history", strategy: "direct", pk: ["id"], notes: "Immutable history; INSERT is not guarded." },
      { table: "audit_logs", strategy: "direct", pk: ["id"], notes: "Append-only; INSERT is not guarded, so the guards stay active throughout." },
      { table: "moderation_logs", strategy: "direct", pk: ["id"], notes: "Append-only; INSERT is not guarded." },
    ],
  },
]

export const ALL_TABLES: TableSpec[] = PHASES.flatMap((p) => p.tables)

/** Tables read from the source (everything except derived ones). */
export const COPIED_TABLES: TableSpec[] = ALL_TABLES.filter((t) => t.strategy !== "derived")

/** The 0008 seed row counts a fresh target holds in its reference tables. */
export const REFERENCE_SEED_COUNTS: Record<string, number> = {
  creation_pricing: 9,
  candy_packages: 3,
  characters: 10,
  referral_program_settings: 1,
  homepage_content: 1,
  homepage_hero_layout: 1,
}

/** Singletons the application needs; a source without them is refused. */
export const REQUIRED_SINGLETONS = ["referral_program_settings", "homepage_content", "homepage_hero_layout"]

/** Not copied, by design. */
export const EXCLUDED = [
  { object: "auth schema (users, identities, sessions, refresh tokens, MFA)", reason: "Credentials and sessions stay with the identity provider. The user <-> provider link is derived into user_identities." },
  { object: "storage schema (buckets, objects)", reason: "Object bytes and storage metadata move in the later storage migration. Cartoona keeps its own keys in media_assets/examples/homepage_media_assets." },
  { object: "supabase_migrations, realtime, vault, graphql, extensions schemas", reason: "Supabase platform internals." },
  { object: "public.schema_migrations (target)", reason: "Owned by the target migration runner; verified, never written." },
  { object: "RLS policies, grants, Supabase roles", reason: "Replaced by backend authorization and the cartoona_app role." },
  { object: "public.internal_write_nonces (target)", reason: "Target-only replay protection for backend writes (0012); has no Supabase counterpart and starts empty." },
]

export const DEFERRED = [
  { object: "storage object bytes", reason: "Storage migration task (keys are preserved, so objects can be moved by key)." },
  { object: "users.sessions_not_before values", reason: "Never derived from Supabase auth.sessions; NULL until the trusted invalidation operation exists." },
]

/**
 * The exact migration set this tool was audited against. A target with any
 * other set (missing, extra, reordered or edited) is refused: a new migration
 * means the mapping must be re-audited first.
 */
export const EXPECTED_TARGET_MIGRATIONS = [
  "0001_extensions",
  "0002_tables",
  "0003_identity",
  "0004_helpers_and_triggers",
  "0005_business_functions",
  "0006_append_only_guards",
  "0007_privileges",
  "0008_reference_data",
  "0009_application_role",
  "0010_identity_read_grant",
  "0011_users_sessions_not_before",
  "0012_internal_write_nonces",
  "0013_parent_profile_name_update_grant",
  "0014_parent_consent_write",
  "0015_supabase_parent_provisioning",
]

export const IDENTITY_PROVIDER = "supabase"

/** Tool-owned bookkeeping schema in the target. No application role has any privilege on it. */
export const META_SCHEMA = "cartoona_data_copy"

export const TOOL_VERSION = "V0.1.44"

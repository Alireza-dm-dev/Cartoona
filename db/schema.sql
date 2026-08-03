-- =============================================================================
-- Cartoona Database Schema — Draft v0
-- =============================================================================
-- This is the initial schema draft for the Cartoona platform.
-- It defines the core data model: users, profiles, orders, content, and audit.
-- See docs/AUTH_RLS_PLAN.md for the full auth, role, and RLS architecture plan.
--
-- RLS STATUS (order-related tables — migration 20260717220000):
--   public.orders                         RLS ENABLED — parent SELECT own, admin SELECT all
--   public.media_assets                    RLS ENABLED — parent SELECT own orders', admin SELECT all
--   public.video_requests                  RLS ENABLED — parent SELECT own orders', admin SELECT all
--   public.drawing_animation_requests      RLS ENABLED — parent SELECT own orders', admin SELECT all
--   All four: no direct INSERT/UPDATE/DELETE from client roles.
--   Request creation only through public.create_parent_request RPC.
--
-- RPC (migration 20260717220001):
--   public.create_parent_request() — atomic parent request submission.
--   Derives parent ownership from auth.uid().
--   Verifies parent role, granted consent, active characters,
--   private file path ownership, and storage MIME type.
--   Computes candy cost server-side. No candy deduction.
--
-- RPC (migration 20260725120000):
--   public.get_current_parent_session_policy() — parent session lifetime.
--   Returns session_started_at, expires_at (created_at + 30 days),
--   and is_valid (now < expires_at).
--   Non-sliding 30-day limit. Parent-only. Uses auth.sessions.created_at
--   and JWT session_id. Admin/super_admin return invalid row.
--
-- CANDY / LEDGER (migration 20260726100000):
--   public.candy_wallets                  RLS ENABLED — parent own SELECT, admin SELECT all
--   public.candy_transactions             RLS ENABLED — parent own SELECT, admin SELECT all
--   Both: no direct INSERT/UPDATE/DELETE from client roles.
--   Trigger: ensure_parent_candy_wallet — auto-creates wallet on parent profile insert.
--   Trigger: prevent_candy_transaction_mutation — append-only enforcement.
--   Constraint: candy_transactions.amount <> 0.
--   Column: candy_transactions.idempotency_key (nullable, unique partial index).
--
-- ATOMIC DEBIT (migration 20260726110000):
--   public.create_parent_request now:
--     - Resolves parent wallet via parent_profiles.
--     - Locks wallet row FOR UPDATE against concurrent requests.
--     - Rejects INSUFFICIENT_CANDIES when balance < candy_cost.
--     - Rejects CANDY_WALLET_NOT_FOUND when wallet is missing.
--     - After successful order + media/request inserts, deducts wallet balance.
--     - Appends one immutable order_debit ledger transaction.
--     - Uses idempotency_key = 'order_debit:' || order_id to prevent duplicates.
--     - Still computes candy_cost server-side (duplicated from config/candy-costs.ts).
--   Pricing consolidation (move costs to DB-backed config) is pending.
--   Wallet deduction and order creation are one atomic transaction.
--   Failed orders cannot leave a deduction.
--
-- CREATION PRICING (migration 20260726120000):
--   public.creation_pricing               RLS ENABLED
--     Authoritative creation-pricing catalog.
--     pricing_key is the stable machine-readable identifier.
--     candy_cost is a positive integer.
--     Only active (is_active = TRUE) rows are publicly visible.
--     Admins may read inactive prices.
--     Browser clients cannot write pricing rows.
--     Seeded with the current nine pricing components.
--
-- RPC PRICING LOOKUP (migration 20260726130000):
--   create_parent_request now resolves pricing exclusively through
--   public.creation_pricing — no hardcoded numeric candy prices remain.
--   Request metadata (type, duration_key, file presence) is mapped to
--   stable pricing keys and looked up against active catalog rows.
--   Missing or inactive prices fail closed with CREATION_PRICING_UNAVAILABLE.
--   The catalog-derived amount is used for orders.candy_cost, wallet
--   deduction, and the order_debit ledger entry.
--   Historical orders retain their submitted cost.
--   config/candy-costs.ts still exists temporarily for UI display and
--   will be removed in a later task.
--
-- TODO:
--  - Implement soft delete retention policy.
-- =============================================================================

-- ============================================================
-- USERS
-- ============================================================
-- Extends Supabase auth.users with application-level role.
-- A trigger on auth.users after insert creates a matching public.users row.
-- TODO: Add RLS — users can read/update own record; admin/super_admin can read all.
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'parent' CHECK (role IN ('parent', 'admin', 'super_admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

-- Automatically creates a public.users row when a new auth.users row is created.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, 'parent');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- PARENT PROFILES
-- ============================================================
-- Each parent user has one profile with consent tracking.
-- RLS: parent INSERT/UPDATE/SELECT own; admin SELECT all (migrations 00004, parent_consent_persistence).
CREATE TABLE IF NOT EXISTS public.parent_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  consent_granted   BOOLEAN NOT NULL DEFAULT FALSE,
  consent_granted_at TIMESTAMPTZ,
  referral_code     TEXT NOT NULL UNIQUE CHECK (referral_code ~ '^CT[0-9A-F]{12}$'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CHILD PROFILES
-- ============================================================
-- Optional profiles created by parents for personalization.
-- Children do NOT have independent accounts.
-- TODO: Add RLS — parent can CRUD own children; admin can read all.
CREATE TABLE IF NOT EXISTS public.child_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id             UUID NOT NULL REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  birth_year            INTEGER,
  favorite_character_id UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CHARACTERS
-- ============================================================
-- Original character universe managed by admins.
-- TODO: Add RLS — public read for active characters; admin write.
CREATE TABLE IF NOT EXISTS public.characters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  image_url   TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ORDERS
-- ============================================================
-- Core request table — every creation starts here.
-- RLS: parent SELECT own; admin SELECT all. INSERT via create_parent_request RPC only.
CREATE TABLE IF NOT EXISTS public.orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id         UUID NOT NULL REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('image', 'video', 'drawing_animation')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_payment', 'pending_review', 'in_progress', 'ready', 'delivered', 'rejected', 'cancelled')),
  title             TEXT NOT NULL,
  description       TEXT,
  character_id      UUID REFERENCES public.characters(id),
  candy_cost        INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'passed', 'flagged', 'blocked', 'manual_review')),
  assigned_admin_id UUID REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MEDIA ASSETS
-- ============================================================
-- Uploaded and generated media linked to orders.
-- RLS: parent SELECT own orders' assets; admin SELECT all. INSERT via create_parent_request RPC only.
CREATE TABLE IF NOT EXISTS public.media_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('upload', 'generated')),
  file_url          TEXT NOT NULL,
  mime_type         TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'passed', 'flagged', 'blocked', 'manual_review')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CANDY WALLETS
-- ============================================================
-- One wallet per parent.
-- balance is an integer, non-negative, cached for fast reads.
-- Updated atomically by trusted SECURITY DEFINER functions only.
-- Parents may SELECT own wallet; admins may SELECT all.
-- No direct parent or authenticated INSERT/UPDATE/DELETE.
--
-- RLS: ENABLED (migration 20260726100000)
--   candy_wallets_select_own    — parent SELECT own (via auth.uid() → parent_profiles)
--   candy_wallets_select_admin  — admin/super_admin SELECT all
-- Trigger: ensure_parent_candy_wallet on parent_profiles AFTER INSERT
--   Creates zero-balance wallet on new parent profile creation. Idempotent.
-- Trigger: candy_wallets_set_updated_at BEFORE UPDATE
--   Maintains updated_at column.
CREATE TABLE IF NOT EXISTS public.candy_wallets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL UNIQUE REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CANDY TRANSACTIONS
-- ============================================================
-- Immutable, append-only ledger of candy movements.
-- Positive amounts = credits (purchase, grant, refund).
-- Negative amounts = debits (spend).
-- Corrections and refunds must append reversal entries, never edit history.
-- Parents may SELECT own transactions; admins may SELECT all.
-- No direct INSERT/UPDATE/DELETE from any client role.
-- Trusted SECURITY DEFINER RPCs append rows atomically alongside wallet updates.
--
-- RLS: ENABLED (migration 20260726100000)
--   candy_transactions_select_own   — parent SELECT own (via wallet → parent_profile → auth.uid())
--   candy_transactions_select_admin — admin/super_admin SELECT all
-- Trigger: prevent_candy_transaction_mutation BEFORE UPDATE OR DELETE
--   Raises exception on any edit or deletion. Append-only enforcement.
-- Constraint: amount <> 0
--   Zero-amount entries are meaningless in a ledger.
-- Idempotency: idempotency_key TEXT, unique partial index WHERE NOT NULL
--   Server-generated; prevents duplicate entries on RPC retry.
-- Order candy deduction: NOT YET CONNECTED.
--   The create_parent_request RPC computes candy_cost but does not
--   deduct from wallet or write a transaction. That is a future task.
CREATE TABLE IF NOT EXISTS public.candy_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES public.candy_wallets(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL CHECK (amount <> 0),
  type            TEXT NOT NULL CHECK (type IN ('purchase', 'spend', 'refund', 'grant')),
  reference_type  TEXT,
  reference_id    TEXT,
  description     TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- VIDEO REQUESTS
-- ============================================================
-- Extended details for video-type orders.
-- RLS: parent SELECT own; admin SELECT all. INSERT via create_parent_request RPC only.
CREATE TABLE IF NOT EXISTS public.video_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  script          TEXT,
  duration_seconds INTEGER,
  style           TEXT,
  output_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- DRAWING ANIMATION REQUESTS
-- ============================================================
-- Extended details for drawing_animation-type orders.
-- RLS: parent SELECT own; admin SELECT all. INSERT via create_parent_request RPC only.
CREATE TABLE IF NOT EXISTS public.drawing_animation_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  upload_url      TEXT NOT NULL,
  animation_style TEXT,
  output_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MODERATION LOGS
-- ============================================================
-- Tracks moderation actions on all content types.
-- TODO: Add RLS — admin write/read only.
CREATE TABLE IF NOT EXISTS public.moderation_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   TEXT NOT NULL,
  target_id     UUID NOT NULL,
  action        TEXT NOT NULL,
  moderator_id  UUID REFERENCES public.users(id),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
-- Immutable audit trail for sensitive operations.
-- TODO: Add RLS — admin write/read only.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   UUID NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- EXAMPLES
-- ============================================================
-- Curated examples shown on the public /showcase page.
-- Admins manage these through the CMS admin interface.
-- TODO: Add RLS — public read for published; admin CRUD for all.
CREATE TABLE IF NOT EXISTS public.examples (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('video', 'drawing', 'story')),
  title            TEXT NOT NULL,
  badge_label      TEXT NOT NULL DEFAULT '' CHECK (char_length(badge_label) <= 40),
  description      TEXT,
  character_id     UUID REFERENCES public.characters(id) ON DELETE SET NULL,
  media_url        TEXT NOT NULL,
  thumbnail_url    TEXT,
  is_published     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CREATION PRICING
-- ============================================================
-- Authoritative creation-pricing catalog. A stable pricing_key maps
-- a request type + options to a positive integer candy cost.
-- Only active rows are publicly visible.
-- Browser clients cannot write pricing rows.
-- create_parent_request still uses hardcoded SQL prices (next migration).
-- config/candy-costs.ts remains temporarily duplicated (public loader task).
CREATE TABLE IF NOT EXISTS public.creation_pricing (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_key  TEXT NOT NULL,
  candy_cost   INTEGER NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- PRIVATE STORAGE BUCKETS
-- ============================================================
-- These buckets are NOT represented as public-schema tables.
-- They are managed through the Supabase storage schema.
-- RLS policies are defined in supabase/migrations/.
--
-- parent-uploads:
--   Private. Parent INSERT/SELECT/DELETE own files (path starts
--   with their auth.uid()). Admin SELECT for reviewing submissions.
--   MIME: image/jpeg, image/png, image/webp. Max 10 MiB.
--
-- generated-media:
--   Private. Admin CRUD. Parent SELECT own completed files (path
--   starts with their auth.uid()). Parents cannot write.
--   MIME: image/jpeg, image/png, image/webp, video/mp4, video/webm.
--   Max 100 MiB.
--
-- Helper functions:
--   public.is_parent()  — true when auth.uid() role = 'parent'
--   public.is_admin()   — true when auth.uid() role IN ('admin','super_admin')
--
-- Request creation RPC:
--   public.create_parent_request(order_id, type, title, description,
--     character_id, duration_key, video_script, video_style,
--     animation_style, file_path)
--   Returns: id, type, status, candy_cost
--   Atomic. SECURITY DEFINER. Parent role + consent required.
--   Computes candy cost server-side.
--   Locks wallet FOR UPDATE, checks sufficient balance.
--   Inserts order, media_assets, type-specific rows.
--   Deducts wallet balance.
--   Appends order_debit ledger entry with idempotency_key.
--   Single transaction: any failure rolls everything back.
--   Pricing consolidation (move costs to DB) is pending.
--
-- REFERRAL (migration 20260727100000):
--   public.parent_profiles.referral_code — unique, immutable, DB-generated
--     Format: CT + 12 uppercase hex characters (^CT[0-9A-F]{12}$)
--     Generated by generate_parent_referral_code() using extensions.gen_random_bytes(6)
--     BEFORE INSERT trigger auto-assigns (overrides client input)
--     BEFORE UPDATE trigger prevents changes (ERR_PARENT_REFERRAL_CODE_IMMUTABLE)
--     Backfilled for all 49 existing profiles
--
--   public.referral_program_settings — RLS ENABLED, authenticated SELECT all
--     Singleton (id=1, CHECK id=1). No browser writes.
--     reward_basis_points 1500 (15%), range 0–10000.
--     set_updated_at trigger. updated_by FK→public.users ON DELETE SET NULL.
--
--   public.referral_relationships — RLS ENABLED
--     authenticated: parent SELECT own incoming; admin SELECT all
--     No INSERT/UPDATE/DELETE policies — created via trusted RPC only
--     FK ON DELETE SET NULL preserves relationship row on account deletion
--     One binding per referred_parent_id (partial unique index)
--     Self-referral forbidden (CHECK)
--     referral_code_snapshot: immutable copy of referrer code at binding time
--
--   Rewards / payment schema not yet introduced (deferred).
--
-- REFERRAL BINDING (migration 20260727110000):
--   public.get_current_parent_referral_summary() — parent-only SECURITY DEFINER RPC.
--     Returns own referral_code, program settings (is_enabled, reward_basis_points),
--     binding state (is_bound, bound_at), and referred_count (BIGINT).
--     No other-parent identity is exposed. Requires auth.uid() + parent role.
--     Caller must enforce 30-day session before calling.
--
--   public.bind_current_parent_referral_code(p_code TEXT) — parent-only SECURITY DEFINER RPC.
--     One-time permanent binding. Idempotent for same-code resubmission.
--     Rate-limited to 5 attempts per parent per fixed 1-minute window.
--     Normalizes input: trim → Persian/Arabic digit conversion → uppercase → pattern check.
--     Invalid, missing, and self codes all return invalid_code (undistinguishable).
--     Binding uses FOR UPDATE row lock on parent profile for concurrency safety.
--     Returns status: bound, already_bound_same, already_bound_other, invalid_code,
--     program_disabled, rate_limited, profile_not_found, session_expired.
--
--   public.normalize_referral_code(p_code TEXT) — IMMUTABLE.
--     Trims whitespace, converts Persian/Arabic digits to ASCII, uppercases,
--     validates ^CT[0-9A-F]{12}$. Returns NULL for invalid input.
--
--   public.referral_binding_rate_limits — internal rate-limit table.
--     One row per parent (PK → parent_profiles ON DELETE CASCADE).
--     window_started_at TIMESTAMPTZ, attempt_count INTEGER ≥ 0.
--     RLS enabled, no client policies. Only SECURITY DEFINER functions access it.
--     Atomic UPSET resolves per-minute window. Max 5 attempts.
--
--   public.check_referral_binding_rate_limit(p_parent_id UUID) — returns BOOLEAN.
--     Atomic UPSERT with conditional window reset and counter increment.
--     TRUE if ≤ 5 attempts in current window, FALSE if rate-limited.
--   Only called by other SECURITY DEFINER functions.
--
--   Rewards / payment schema not yet introduced (deferred).
--
-- CANDY PURCHASE FOUNDATION (migration 20260729100000):
--   public.candy_packages — predefined purchase catalogs.
--     RLS ENABLED. authenticated SELECT active only; admin SELECT all.
--     No browser INSERT/UPDATE/DELETE.
--     Seeded with Starter (100 🍬), Growth (300 🍬), Premium (700 🍬).
--     Prices are placeholders (IRR). Updated when real payment is integrated.
--
--   public.candy_purchases — purchase attempt records.
--     RLS ENABLED. parent SELECT own; admin SELECT all. No direct writes.
--     Status lifecycle: pending → paid | failed | cancelled.
--     Created via POST /api/candy-purchases (authenticated parent endpoint).
--     Completed via POST /api/candy-purchases/[id]/complete.
--
--   public.complete_candy_purchase(UUID, TEXT) — SECURITY DEFINER RPC.
--     [DEVELOPMENT-ONLY] Simulates payment completion.
--     Verifies: auth → parent role → profile → FOR UPDATE lock →
--     ownership → pending status → UPDATE purchase to paid →
--     FOR UPDATE lock wallet → credit balance → INSERT ledger entry.
--     Idempotent via idempotency_key = 'purchase_credit:' || purchase_id.
--     No real payment gateway involved. Marked for removal when real
--     payment is integrated.
--
--   API endpoints (see app/api/candy-purchases/):
--     POST /api/candy-purchases — create pending purchase (parent auth).
--     POST /api/candy-purchases/[id]/complete — dev completion (parent auth).
--
-- ADMIN REFERRAL MANAGEMENT (migration 20260727120000):
--   public.referral_program_settings_history — immutable audit trail.
--     UUID PK, actor_user_id→users(id) ON DELETE SET NULL.
--     Stores previous/new is_enabled and reward_basis_points (0-10000).
--     Checks that at least one value changed (settings_history_values_differ).
--     Indexed on changed_at DESC, actor_user_id (partial)
--     UPDATE/DELETE prevented by BEFORE triggers
--     RLS: admin/super_admin SELECT only (role check via EXISTS subquery).
--     REVOKE ALL from PUBLIC/anon, GRANT SELECT to authenticated.
--     INSERT only via SECURITY DEFINER update RPC (same transaction).
--
--   public.get_admin_referral_overview() — admin-only SECURITY DEFINER RPC.
--     Returns settings, counts (parents, relationships, unbound, deleted-identity, history).
--     Requires auth.uid() + admin/super_admin role.
--
--   public.get_admin_referral_relationships(p_search, p_limit, p_offset) —
--     admin-only, paginated (1-50), max 100-char search, case-insensitive ILIKE
--     across snapshot/code/name/email. Deleted-parent returns NULL.
--     Sorted by bound_at DESC, id ASC.
--
--   public.update_admin_referral_program_settings(...) — admin-only.
--     Optimistic concurrency via p_expected_updated_at.
--     Conflict → no update. No-op → no history. Real change → update + history in one tx.
--     All three: GRANT EXECUTE authenticated, REVOKE ALL from anon/PUBLIC.

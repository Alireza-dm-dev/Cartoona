-- Migration: remove_all_synthetic_test_data
-- Description: One-time pre-launch cleanup. Removes every proven synthetic test
-- and seed artifact from the main Cartoona Supabase project while preserving
-- the two real administrative accounts and all application configuration.
--
-- Safe states:
--   A. Dirty (97 synthetic auth users, 99 total) — performs full cleanup.
--   B. Clean (0 synthetic users) — safe no-op.
--   Any other count → raises exception and rolls back.

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 1: Build synthetic-user manifest (deterministic predicate)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _synth_auth_ids AS
SELECT id
FROM auth.users
WHERE email IS NULL
   OR email ILIKE '%@test.com'
   OR email ILIKE '%@dev.cartoona.example'
   OR email ILIKE '%@t.co'
   OR email ILIKE '%@test.co'
   OR email ILIKE '%@test.cartoona.local'
   OR email ILIKE '%@cartoona.dev';

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 2: Verify known state — no-op or cleanup
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_synth   INT;
  v_total   INT;
  v_profiles INT;
  v_wallets  INT;
  v_rels     INT;
BEGIN
  SELECT COUNT(*) INTO v_synth FROM _synth_auth_ids;
  SELECT COUNT(*) INTO v_total FROM auth.users;

  -- ── Clean environment: nothing to clean ──────────────────────────────
  IF v_synth = 0 THEN
    RETURN;
  END IF;

  -- ── Dirty environment: 97 synthetic + 2 real = 99 ───────────────────
  IF v_synth != 97 THEN
    RAISE EXCEPTION 'Expected 0 or 97 synthetic auth users, found %', v_synth;
  END IF;

  IF v_total != 99 THEN
    RAISE EXCEPTION 'Expected 99 total auth users, found %', v_total;
  END IF;

  -- Verify related-artifact counts match expected dirty state
  SELECT COUNT(*) INTO v_profiles FROM public.parent_profiles;
  IF v_profiles != 75 THEN
    RAISE EXCEPTION 'Expected 75 parent_profiles, found %', v_profiles;
  END IF;

  SELECT COUNT(*) INTO v_wallets FROM public.candy_wallets;
  IF v_wallets != 75 THEN
    RAISE EXCEPTION 'Expected 75 candy_wallets, found %', v_wallets;
  END IF;

  SELECT COUNT(*) INTO v_rels FROM public.referral_relationships;
  IF v_rels != 102 THEN
    RAISE EXCEPTION 'Expected 102 referral_relationships, found %', v_rels;
  END IF;

  -- Verify zero balance (safety: no financial data should be deleted)
  IF EXISTS (SELECT 1 FROM public.candy_wallets WHERE balance != 0) THEN
    RAISE EXCEPTION 'Non-zero wallet balance found — aborting cleanup';
  END IF;

  -- Verify no real customer data exists
  IF EXISTS (SELECT 1 FROM public.orders) THEN
    RAISE EXCEPTION 'Orders table is not empty — aborting cleanup';
  END IF;

  IF EXISTS (SELECT 1 FROM public.child_profiles) THEN
    RAISE EXCEPTION 'child_profiles table is not empty — aborting cleanup';
  END IF;

  IF EXISTS (SELECT 1 FROM public.candy_transactions) THEN
    RAISE EXCEPTION 'candy_transactions table is not empty — aborting cleanup';
  END IF;

  IF EXISTS (SELECT 1 FROM public.media_assets) THEN
    RAISE EXCEPTION 'media_assets table is not empty — aborting cleanup';
  END IF;

  IF EXISTS (SELECT 1 FROM public.audit_logs) THEN
    RAISE EXCEPTION 'audit_logs table is not empty — aborting cleanup';
  END IF;

  IF EXISTS (SELECT 1 FROM public.moderation_logs) THEN
    RAISE EXCEPTION 'moderation_logs table is not empty — aborting cleanup';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 3: Remove synthetic Auth schema rows
-- ────────────────────────────────────────────────────────────────────────────
-- Delete dependent rows before auth.users to handle any RESTRICT FKs.

DELETE FROM auth.identities  WHERE user_id IN (SELECT id FROM _synth_auth_ids);
DELETE FROM auth.sessions    WHERE user_id IN (SELECT id FROM _synth_auth_ids);

-- ── Remove synthetic auth.users ───────────────────────────────────────────
-- Cascade: auth.users → public.users → parent_profiles → candy_wallets
--          referral_binding_rate_limits rows are deleted via parent CASCADE
--          referral_relationships refs are SET NULL via FK ON DELETE SET NULL
DELETE FROM auth.users WHERE id IN (SELECT id FROM _synth_auth_ids);

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 4: Remove orphaned referral relationships
-- ────────────────────────────────────────────────────────────────────────────
-- After the cascade above, all 102 relationship rows have null parent refs
-- (ON DELETE SET NULL). Delete all proven synthetic rows.

DO $$
DECLARE
  v_remaining INT;
BEGIN
  SELECT COUNT(*) INTO v_remaining FROM public.referral_relationships;
  IF v_remaining = 102 THEN
    DELETE FROM public.referral_relationships;
  ELSIF v_remaining != 0 THEN
    RAISE EXCEPTION 'Expected 0 or 102 referral_relationships after cleanup, found %', v_remaining;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 5: Final assertions (only when cleanup actually ran)
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_synth    INT;
  v_count    INT;
  v_balance  BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_synth FROM _synth_auth_ids;
  IF v_synth = 0 THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_count FROM auth.users;
  IF v_count != 2 THEN RAISE EXCEPTION 'Expected 2 auth.users, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.users;
  IF v_count != 2 THEN RAISE EXCEPTION 'Expected 2 public.users, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.users WHERE role = 'parent';
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 parent-role users, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.parent_profiles;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 parent_profiles, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.candy_wallets;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 candy_wallets, found %', v_count; END IF;

  SELECT COALESCE(SUM(balance), 0) INTO v_balance FROM public.candy_wallets;
  IF v_balance != 0 THEN RAISE EXCEPTION 'Expected 0 total wallet balance, found %', v_balance; END IF;

  SELECT COUNT(*) INTO v_count FROM public.candy_transactions;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 candy_transactions, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.referral_relationships;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 referral_relationships, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.referral_binding_rate_limits;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 referral_binding_rate_limits, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.orders;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 orders, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.child_profiles;
  IF v_count != 0 THEN RAISE EXCEPTION 'Expected 0 child_profiles, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.creation_pricing;
  IF v_count != 9 THEN RAISE EXCEPTION 'Expected 9 creation_pricing rows, found %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM public.referral_program_settings WHERE id = 1 AND is_enabled = true AND reward_basis_points = 1500;
  IF v_count != 1 THEN RAISE EXCEPTION 'Referral settings mismatch — expected id=1, enabled=true, 1500bps'; END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Cleanup
-- ────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS _synth_auth_ids;

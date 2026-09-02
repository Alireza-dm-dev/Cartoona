-- Migration: remove_referral_test_history
-- One-time pre-launch cleanup of synthetic settings-history rows created by automated
-- database-level and API-level tests against the main Supabase project.
--
-- The admin referral management features (migration 20260727120000) were developed and
-- tested against the live project oucyhmrnzahlhqjfqcge before a disposable-test-project
-- guardrail existed. All 94 history rows were created by synthetic test-user actors
-- between 2026-07-28 10:26 and 12:06 UTC.
--
-- Evidence that every row is a test artifact:
--   1. The history table was created by migration 20260727120000, applied on July 28.
--   2. Every row's changed_at falls within the automated test execution window.
--   3. The 16 distinct actor_user_ids match synthetic test users (created second before
--      their first history row, role=admin or super_admin).
--   4. Row patterns (enable→disable→re-enable, rate 0→10000→500→2000) match test logic,
--      not legitimate administrative actions.
--   5. No admin referral UI exists — no human admin could have made these changes.
--   6. The table had zero rows before this date.
--
-- This is a one-time pre-launch operation. After launch, all history is immutable.
-- =============================================================================

-- Verify the expected synthetic count before any mutation.
DO $$
DECLARE
  v_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.referral_program_settings_history;

  IF v_count <> 94 THEN
    RAISE EXCEPTION 'Expected exactly 94 synthetic history rows, found % — aborting cleanup.',
      v_count
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Temporarily disable the immutability trigger so we can delete test artifacts.
DROP TRIGGER IF EXISTS trg_prevent_settings_history_delete
  ON public.referral_program_settings_history;

-- Delete all rows. They are all synthetic — see evidence above.
DELETE FROM public.referral_program_settings_history;

-- Re-create the immutability trigger.
CREATE TRIGGER trg_prevent_settings_history_delete
  BEFORE DELETE ON public.referral_program_settings_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_settings_history_mutation();

-- Verify no rows remain.
DO $$
DECLARE
  v_remaining BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_remaining FROM public.referral_program_settings_history;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'Cleanup failed: % rows remain after deletion.', v_remaining
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Verify immutability is restored: both UPDATE and DELETE triggers must be active.
DO $$
DECLARE
  v_del INTEGER;
  v_upd INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_del
  FROM pg_trigger
  WHERE tgrelid = 'public.referral_program_settings_history'::regclass
    AND tgname = 'trg_prevent_settings_history_delete'
    AND tgenabled = 'O';

  SELECT COUNT(*) INTO v_upd
  FROM pg_trigger
  WHERE tgrelid = 'public.referral_program_settings_history'::regclass
    AND tgname = 'trg_prevent_settings_history_update'
    AND tgenabled = 'O';

  IF v_del = 0 OR v_upd = 0 THEN
    RAISE EXCEPTION 'Immutability trigger was not fully restored after cleanup.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

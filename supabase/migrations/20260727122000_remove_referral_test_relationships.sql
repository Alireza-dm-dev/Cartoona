-- Migration: remove_referral_test_relationships
-- One-time pre-launch cleanup of 2 synthetic referral-relationship rows created by
-- automated tests against the main Supabase project before the destructive-test guard
-- was properly enforced.
--
-- These 2 rows were created during unguarded test execution at 2026-07-28 13:46 UTC
-- when the test-isolation guard did not yet load environment variables before checking
-- the target project. The guard silently returned "unknown target" (not "main project")
-- because process.env.NEXT_PUBLIC_SUPABASE_URL was not set in the Playwright process.
-- Both parent profiles were cascade-deleted when the test Auth users were removed in
-- afterAll, leaving orphaned rows with NULL referrer_parent_id and referred_parent_id.
--
-- Evidence that both rows are test artifacts:
--   1. bound_at timestamps (13:46:57 and 13:46:58 UTC) match the unguarded execution
--      window of this session.
--   2. Both referrer_parent_id and referred_parent_id are NULL — the profiles were
--      cascade-deleted with the synthetic test user.
--   3. Neither referral_code_snapshot value matches any existing parent_profile.
--   4. The binding_source is "manual" for both — matching the test code path.
--   5. No referral admin UI exists — no legitimate binding could have been created
--      and then had its parent profiles deleted through normal operations.
--   6. No legitimate parent profile has ever been deleted from this database.
--   7. These are the only 2 rows with bound_at after 13:00 UTC on July 28.
--   8. All 104 rows in this table are synthetic (bound between July 27 and July 28,
--      no legitimate referral program exists), but this migration only targets the 2
--      rows from the most recent unguarded test run. Earlier test rows are tracked
--      separately and may be cleaned in a future migration.
-- =============================================================================

-- Verify the expected synthetic count before any mutation.
DO $$
DECLARE
  v_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.referral_relationships
  WHERE bound_at >= '2026-07-28T13:46:57' AND bound_at <= '2026-07-28T13:46:59'
    AND referrer_parent_id IS NULL
    AND referred_parent_id IS NULL;

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected exactly 2 synthetic relationship rows matching the time+null predicate, found % — aborting cleanup.',
      v_count
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Delete the 2 verified synthetic rows.
DELETE FROM public.referral_relationships
WHERE bound_at >= '2026-07-28T13:46:57' AND bound_at <= '2026-07-28T13:46:59'
  AND referrer_parent_id IS NULL
  AND referred_parent_id IS NULL;

-- Verify no targeted rows remain.
DO $$
DECLARE
  v_remaining BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM public.referral_relationships
  WHERE bound_at >= '2026-07-28T13:46:57' AND bound_at <= '2026-07-28T13:46:59'
    AND referrer_parent_id IS NULL
    AND referred_parent_id IS NULL;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'Cleanup failed: % rows remain after deletion.',
      v_remaining
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

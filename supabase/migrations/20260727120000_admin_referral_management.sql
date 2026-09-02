-- Migration: admin_referral_management
-- Creates admin referral-management backend objects:
--   1. Immutable referral-program-settings history table
--   2. Admin relationship-listing RPC
--   3. Admin overview RPC
--   4. Controlled settings-update RPC
--   5. RLS, grants, revokes, and mutation prevention
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Settings history table (immutable, audit-only, no direct browser INSERT)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.referral_program_settings_history (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id             UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  previous_is_enabled       BOOLEAN NOT NULL,
  new_is_enabled            BOOLEAN NOT NULL,
  previous_reward_basis_points INTEGER NOT NULL CHECK (previous_reward_basis_points >= 0 AND previous_reward_basis_points <= 10000),
  new_reward_basis_points      INTEGER NOT NULL CHECK (new_reward_basis_points >= 0 AND new_reward_basis_points <= 10000),
  changed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_history_values_differ CHECK (
    previous_is_enabled IS DISTINCT FROM new_is_enabled
    OR previous_reward_basis_points IS DISTINCT FROM new_reward_basis_points
  )
);

-- Index for chronological admin queries
CREATE INDEX IF NOT EXISTS idx_settings_history_changed_at
  ON public.referral_program_settings_history (changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_settings_history_actor
  ON public.referral_program_settings_history (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

COMMENT ON TABLE public.referral_program_settings_history IS
  'Immutable audit trail for referral-program-settings changes. INSERT only via SECURITY DEFINER RPC.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. History immutability enforcement
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.prevent_settings_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'referral_program_settings_history is immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_settings_history_update
  ON public.referral_program_settings_history;
CREATE TRIGGER trg_prevent_settings_history_update
  BEFORE UPDATE ON public.referral_program_settings_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_settings_history_mutation();

DROP TRIGGER IF EXISTS trg_prevent_settings_history_delete
  ON public.referral_program_settings_history;
CREATE TRIGGER trg_prevent_settings_history_delete
  BEFORE DELETE ON public.referral_program_settings_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_settings_history_mutation();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. History RLS and grants
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.referral_program_settings_history ENABLE ROW LEVEL SECURITY;

-- Admin/super_admin can read all history
DROP POLICY IF EXISTS "admin_select_settings_history"
  ON public.referral_program_settings_history;
CREATE POLICY "admin_select_settings_history"
  ON public.referral_program_settings_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

-- No other policies — no INSERT, UPDATE, DELETE for any client role.

REVOKE ALL ON public.referral_program_settings_history FROM PUBLIC;
REVOKE ALL ON public.referral_program_settings_history FROM anon;
REVOKE ALL ON public.referral_program_settings_history FROM authenticated;

GRANT SELECT ON public.referral_program_settings_history TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Admin referral-relationships listing RPC
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_admin_referral_relationships(
  p_search TEXT DEFAULT NULL,
  p_limit  INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  relationship_id           UUID,
  bound_at                  TIMESTAMPTZ,
  binding_source            TEXT,
  referral_code_snapshot    TEXT,
  referred_parent_name      TEXT,
  referred_parent_email     TEXT,
  referrer_parent_name      TEXT,
  referrer_parent_email     TEXT,
  referrer_current_code     TEXT,
  total_count               BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_role    TEXT;
  v_search  TEXT;
BEGIN
  -- 1. Authenticate
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- 2. Verify admin/super_admin role
  SELECT u.role INTO v_role
  FROM public.users AS u
  WHERE u.id = v_user_id;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'super_admin') THEN
    RETURN;
  END IF;

  -- 3. Validate inputs
  IF p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 50'
      USING ERRCODE = '22023';
  END IF;

  IF p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be 0 or greater'
      USING ERRCODE = '22023';
  END IF;

  -- 4. Normalize search (max 100 chars, empty becomes NULL)
  v_search := NULLIF(pg_catalog.btrim(p_search), '');
  IF v_search IS NOT NULL AND pg_catalog.length(v_search) > 100 THEN
    RAISE EXCEPTION 'p_search exceeds maximum length of 100 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 5. Main query with optional search filter
  RETURN QUERY
  WITH filtered AS (
    SELECT
      r.id,
      r.bound_at,
      r.binding_source,
      r.referral_code_snapshot,
      r.referred_parent_id,
      r.referrer_parent_id
    FROM public.referral_relationships AS r
    WHERE (
      v_search IS NULL
      OR r.referral_code_snapshot ILIKE '%' || v_search || '%'
      OR EXISTS (
        SELECT 1 FROM public.parent_profiles AS pp_ref
        WHERE pp_ref.id = r.referrer_parent_id
          AND pp_ref.referral_code ILIKE '%' || v_search || '%'
      )
      OR EXISTS (
        SELECT 1 FROM public.parent_profiles AS pp_ref
        JOIN public.users AS u_ref ON u_ref.id = pp_ref.user_id
        WHERE pp_ref.id = r.referrer_parent_id
          AND (u_ref.email ILIKE '%' || v_search || '%'
               OR pp_ref.full_name ILIKE '%' || v_search || '%')
      )
      OR EXISTS (
        SELECT 1 FROM public.parent_profiles AS pp_referred
        JOIN public.users AS u_referred ON u_referred.id = pp_referred.user_id
        WHERE pp_referred.id = r.referred_parent_id
          AND (u_referred.email ILIKE '%' || v_search || '%'
               OR pp_referred.full_name ILIKE '%' || v_search || '%')
      )
    )
  ),
  counted AS (
    SELECT COUNT(*)::BIGINT AS total FROM filtered
  )
  SELECT
    f.id,
    f.bound_at,
    f.binding_source,
    f.referral_code_snapshot,
    pp_referred.full_name,
    u_referred.email,
    pp_ref.full_name,
    u_ref.email,
    pp_ref.referral_code,
    c.total
  FROM filtered AS f
  CROSS JOIN counted AS c
  LEFT JOIN public.parent_profiles AS pp_ref
    ON pp_ref.id = f.referrer_parent_id
  LEFT JOIN public.users AS u_ref
    ON u_ref.id = pp_ref.user_id
  LEFT JOIN public.parent_profiles AS pp_referred
    ON pp_referred.id = f.referred_parent_id
  LEFT JOIN public.users AS u_referred
    ON u_referred.id = pp_referred.user_id
  ORDER BY f.bound_at DESC, f.id ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION public.get_admin_referral_relationships IS
  'Paginated, searchable admin listing of referral relationships. Admin/super_admin only. '
  'Deleted-parent fields return NULL. total_count reflects unfiltered count.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Admin referral-overview RPC
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_admin_referral_overview()
RETURNS TABLE (
  is_enabled                        BOOLEAN,
  reward_basis_points               INTEGER,
  settings_updated_at               TIMESTAMPTZ,
  total_parent_profiles             BIGINT,
  total_referral_relationships      BIGINT,
  total_unbound_parent_profiles      BIGINT,
  total_deleted_identity_relationships BIGINT,
  settings_history_count            BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_role    TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RETURN; END IF;

  SELECT u.role INTO v_role
  FROM public.users AS u
  WHERE u.id = v_user_id;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'super_admin') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(ps.is_enabled, FALSE),
    COALESCE(ps.reward_basis_points, 0),
    ps.updated_at,
    (SELECT COUNT(*)::BIGINT FROM public.parent_profiles),
    (SELECT COUNT(*)::BIGINT FROM public.referral_relationships),
    (SELECT COUNT(*)::BIGINT
     FROM public.parent_profiles AS pp
     WHERE NOT EXISTS (
       SELECT 1 FROM public.referral_relationships AS rr
       WHERE rr.referred_parent_id = pp.id
     )
    ),
    (SELECT COUNT(*)::BIGINT
     FROM public.referral_relationships
     WHERE referrer_parent_id IS NULL
        OR referred_parent_id IS NULL
    ),
    (SELECT COUNT(*)::BIGINT
     FROM public.referral_program_settings_history
    )
  FROM (SELECT 1 AS dummy) AS dummy
  LEFT JOIN public.referral_program_settings AS ps ON ps.id = 1;
END;
$$;

COMMENT ON FUNCTION public.get_admin_referral_overview IS
  'Admin/super_admin overview of referral program: settings, parent/relationship counts, '
  'unbound parents, deleted-identity relationships, and history entry count.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Controlled settings-update RPC with optimistic concurrency
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_admin_referral_program_settings(
  p_is_enabled          BOOLEAN,
  p_reward_basis_points INTEGER,
  p_expected_updated_at TIMESTAMPTZ
)
RETURNS TABLE (
  status              TEXT,
  is_enabled          BOOLEAN,
  reward_basis_points INTEGER,
  updated_at          TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id      UUID;
  v_role         TEXT;
  v_current      RECORD;
  v_settings_id  SMALLINT;
  v_new_updated_at TIMESTAMPTZ;
  v_actual_changed BOOLEAN;
BEGIN
  -- 1. Authenticate
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'unauthorized'::TEXT, FALSE::BOOLEAN, 0::INTEGER, pg_catalog.now()::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- 2. Role check
  SELECT u.role INTO v_role
  FROM public.users AS u
  WHERE u.id = v_user_id;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'super_admin') THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, FALSE::BOOLEAN, 0::INTEGER, pg_catalog.now()::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- 3. Validate basis points
  IF p_reward_basis_points < 0 OR p_reward_basis_points > 10000 THEN
    RETURN QUERY SELECT 'invalid_settings'::TEXT, FALSE::BOOLEAN, 0::INTEGER, pg_catalog.now()::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- 4. Lock singleton row and read current values
  SELECT ps.id, ps.is_enabled, ps.reward_basis_points, ps.updated_at
  INTO STRICT v_current
  FROM public.referral_program_settings AS ps
  WHERE ps.id = 1
  FOR UPDATE;

  -- 5. Optimistic concurrency check
  IF v_current.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN QUERY SELECT 'conflict'::TEXT,
      v_current.is_enabled,
      v_current.reward_basis_points,
      v_current.updated_at;
    RETURN;
  END IF;

  -- 6. Determine if anything actually changed
  v_actual_changed :=
    v_current.is_enabled IS DISTINCT FROM p_is_enabled
    OR v_current.reward_basis_points IS DISTINCT FROM p_reward_basis_points;

  IF NOT v_actual_changed THEN
    -- No-op: return current state without updating or writing history
    RETURN QUERY SELECT 'unchanged'::TEXT,
      v_current.is_enabled,
      v_current.reward_basis_points,
      v_current.updated_at;
    RETURN;
  END IF;

  -- 7. Apply update
  v_new_updated_at := pg_catalog.now();
  UPDATE public.referral_program_settings
  SET
    is_enabled          = p_is_enabled,
    reward_basis_points = p_reward_basis_points,
    updated_at          = v_new_updated_at,
    updated_by          = v_user_id
  WHERE id = 1;

  -- 8. Insert immutable history row in the same transaction
  INSERT INTO public.referral_program_settings_history
    (actor_user_id, previous_is_enabled, new_is_enabled,
     previous_reward_basis_points, new_reward_basis_points)
  VALUES
    (v_user_id, v_current.is_enabled, p_is_enabled,
     v_current.reward_basis_points, p_reward_basis_points);

  -- 9. Return updated state
  RETURN QUERY SELECT 'updated'::TEXT,
    p_is_enabled,
    p_reward_basis_points,
    v_new_updated_at;
END;
$$;

COMMENT ON FUNCTION public.update_admin_referral_program_settings IS
  'Admin/super_admin settings update with optimistic concurrency. '
  'Locks singleton row FOR UPDATE. Validates rate (0-10000). '
  'Returns conflict if p_expected_updated_at does not match current. '
  'Returns unchanged if no values differ (no history written). '
  'On real change, updates row and inserts immutable history in one transaction.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Permissions for all admin referral RPCs
-- ═════════════════════════════════════════════════════════════════════════════

-- get_admin_referral_relationships
REVOKE ALL ON FUNCTION public.get_admin_referral_relationships FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_referral_relationships FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_referral_relationships TO authenticated;

-- get_admin_referral_overview
REVOKE ALL ON FUNCTION public.get_admin_referral_overview FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_referral_overview FROM anon;
GRANT EXECUTE ON FUNCTION public.get_admin_referral_overview TO authenticated;

-- update_admin_referral_program_settings
REVOKE ALL ON FUNCTION public.update_admin_referral_program_settings FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_admin_referral_program_settings FROM anon;
GRANT EXECUTE ON FUNCTION public.update_admin_referral_program_settings TO authenticated;

-- Migration: referral_binding_rpcs
-- Adds rate-limit table, parent referral-summary RPC, and one-time
-- referral-code binding RPC. Does not introduce reward/payment schema.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. REFERRAL BINDING RATE-LIMIT TABLE
-- ═════════════════════════════════════════════════════════════════════════════
-- One row per parent. Tracks binding attempts in a fixed one-minute window.
-- Max 5 attempts per parent per window. Sixth attempt is rejected.
-- No client-facing RLS policies — only trusted SECURITY DEFINER functions
-- may read or write this table.

CREATE TABLE IF NOT EXISTS public.referral_binding_rate_limits (
  parent_id         UUID PRIMARY KEY
                    REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempt_count     INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.referral_binding_rate_limits
IS 'Per-parent rate limit state for referral-code binding attempts. Five per fixed one-minute window. Only trusted SECURITY DEFINER functions may access this table.';

ALTER TABLE public.referral_binding_rate_limits ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies — only RPC functions access this.
REVOKE ALL ON public.referral_binding_rate_limits FROM PUBLIC;
REVOKE ALL ON public.referral_binding_rate_limits FROM anon;
REVOKE ALL ON public.referral_binding_rate_limits FROM authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. CODE NORMALIZATION FUNCTION
-- ═════════════════════════════════════════════════════════════════════════════
-- Normalizes a user-supplied referral code:
--   1. Trim whitespace
--   2. Convert Persian digits (۰-۹) to ASCII (0-9)
--   3. Convert Arabic digits (٠-٩) to ASCII (0-9)
--   4. Convert to uppercase
--   5. Validate final pattern
-- Returns NULL when the result does not match ^CT[0-9A-F]{12}$.

CREATE OR REPLACE FUNCTION public.normalize_referral_code(p_code TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_normalized TEXT;
BEGIN
  IF p_code IS NULL THEN
    RETURN NULL;
  END IF;

  v_normalized := pg_catalog.btrim(p_code);

  -- Convert Persian digits (U+06F0–U+06F9)
  v_normalized := pg_catalog.translate(v_normalized,
    chr(x'06F0'::int) || chr(x'06F1'::int) || chr(x'06F2'::int) || chr(x'06F3'::int) ||
    chr(x'06F4'::int) || chr(x'06F5'::int) || chr(x'06F6'::int) || chr(x'06F7'::int) ||
    chr(x'06F8'::int) || chr(x'06F9'::int),
    '0123456789');

  -- Convert Arabic digits (U+0660–U+0669)
  v_normalized := pg_catalog.translate(v_normalized,
    chr(x'0660'::int) || chr(x'0661'::int) || chr(x'0662'::int) || chr(x'0663'::int) ||
    chr(x'0664'::int) || chr(x'0665'::int) || chr(x'0666'::int) || chr(x'0667'::int) ||
    chr(x'0668'::int) || chr(x'0669'::int),
    '0123456789');

  -- Convert to uppercase
  v_normalized := pg_catalog.upper(v_normalized);

  -- Validate pattern
  IF v_normalized ~ '^CT[0-9A-F]{12}$' THEN
    RETURN v_normalized;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.normalize_referral_code(TEXT)
IS 'Normalizes a referral code: trims, converts Persian/Arabic digits to ASCII, uppercases, and validates format. Returns NULL for invalid input.';

REVOKE ALL ON FUNCTION public.normalize_referral_code(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_referral_code(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.normalize_referral_code(TEXT) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. RATE-LIMIT CHECK FUNCTION
-- ═════════════════════════════════════════════════════════════════════════════
-- Atomically checks and records a binding attempt for the given parent.
-- Returns TRUE when the attempt is allowed, FALSE when rate-limited.
-- Max 5 attempts per parent in a rolling fixed one-minute window.
-- Uses atomic UPSERT with row locking to prevent concurrent bypass.

CREATE OR REPLACE FUNCTION public.check_referral_binding_rate_limit(
  p_parent_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_now := pg_catalog.now();

  INSERT INTO public.referral_binding_rate_limits (parent_id, window_started_at, attempt_count)
  VALUES (p_parent_id, v_now, 1)
  ON CONFLICT (parent_id) DO UPDATE SET
    window_started_at = CASE
      WHEN pg_catalog.now() - referral_binding_rate_limits.window_started_at > INTERVAL '1 minute'
        THEN v_now
      ELSE referral_binding_rate_limits.window_started_at
    END,
    attempt_count = CASE
      WHEN pg_catalog.now() - referral_binding_rate_limits.window_started_at > INTERVAL '1 minute'
        THEN 1
      ELSE referral_binding_rate_limits.attempt_count + 1
    END,
    updated_at = v_now
  RETURNING attempt_count INTO v_count;

  RETURN v_count <= 5;
END;
$$;

COMMENT ON FUNCTION public.check_referral_binding_rate_limit(UUID)
IS 'Atomically checks and records a referral binding attempt. Returns TRUE when allowed (≤5 attempts per minute), FALSE when rate-limited.';

REVOKE ALL ON FUNCTION public.check_referral_binding_rate_limit(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_referral_binding_rate_limit(UUID) FROM anon;
-- Only called by other SECURITY DEFINER functions — no direct client grants.

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. PARENT REFERRAL-SUMMARY RPC
-- ═════════════════════════════════════════════════════════════════════════════
-- Returns the current parent's referral code, program settings, binding state,
-- and referred-parent count. No other-parent identity is exposed.

CREATE OR REPLACE FUNCTION public.get_current_parent_referral_summary()
RETURNS TABLE (
  referral_code     TEXT,
  is_enabled        BOOLEAN,
  reward_basis_points INTEGER,
  is_bound          BOOLEAN,
  bound_at          TIMESTAMPTZ,
  referred_count    BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id       UUID;
  v_parent_id     UUID;
  v_settings      RECORD;
  v_relationship  RECORD;
  v_referred_cnt  BIGINT;
BEGIN
  -- 1. Authentication
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- 2. Parent role and session enforcement — caller must confirm before calling
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.role = 'parent') THEN
    RETURN;
  END IF;

  -- 3. Resolve parent profile
  SELECT pp.id INTO v_parent_id
  FROM public.parent_profiles pp
  WHERE pp.user_id = v_user_id;

  IF v_parent_id IS NULL THEN
    RETURN;
  END IF;

  -- 4. Read settings
  SELECT rps.is_enabled, rps.reward_basis_points INTO v_settings
  FROM public.referral_program_settings rps
  WHERE rps.id = 1;

  IF NOT FOUND THEN
    v_settings.is_enabled := FALSE;
    v_settings.reward_basis_points := 0;
  END IF;

  -- 5. Read incoming relationship
  SELECT rr.bound_at INTO v_relationship
  FROM public.referral_relationships rr
  WHERE rr.referred_parent_id = v_parent_id;

  -- 6. Count referred parents
  SELECT pg_catalog.count(*) INTO v_referred_cnt
  FROM public.referral_relationships rr
  WHERE rr.referrer_parent_id = v_parent_id;

  -- 7. Return summary
  RETURN QUERY
  SELECT
    pp.referral_code::TEXT,
    v_settings.is_enabled::BOOLEAN,
    v_settings.reward_basis_points::INTEGER,
    (v_relationship.bound_at IS NOT NULL)::BOOLEAN,
    v_relationship.bound_at,
    v_referred_cnt::BIGINT
  FROM public.parent_profiles pp
  WHERE pp.id = v_parent_id;
END;
$$;

COMMENT ON FUNCTION public.get_current_parent_referral_summary()
IS 'Returns the authenticated parent referral summary: own code, program settings, binding state, and referred count. No other-parent identity exposed.';

REVOKE ALL ON FUNCTION public.get_current_parent_referral_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_current_parent_referral_summary() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_current_parent_referral_summary() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. ONE-TIME BINDING RPC
-- ═════════════════════════════════════════════════════════════════════════════
-- Binds the current authenticated parent to a referrer by referral code.
-- One-time permanent binding. Idempotent for same-code resubmission.
-- Rate-limited to 5 attempts per minute per parent.

CREATE OR REPLACE FUNCTION public.bind_current_parent_referral_code(
  p_code TEXT
)
RETURNS TABLE (
  status   TEXT,
  bound_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id         UUID;
  v_parent_id       UUID;
  v_normalized      TEXT;
  v_referrer_id     UUID;
  v_settings_enabled BOOLEAN;
  v_existing_rel    RECORD;
  v_allow           BOOLEAN;
  v_bound_at        TIMESTAMPTZ;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Authentication
  -- ═══════════════════════════════════════════════════════════════════════════
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'session_expired'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2. Parent role
  -- ═══════════════════════════════════════════════════════════════════════════
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.role = 'parent') THEN
    RETURN QUERY SELECT 'session_expired'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3. Resolve and lock parent profile
  -- ═══════════════════════════════════════════════════════════════════════════
  SELECT pp.id INTO v_parent_id
  FROM public.parent_profiles pp
  WHERE pp.user_id = v_user_id
  FOR UPDATE;

  IF v_parent_id IS NULL THEN
    RETURN QUERY SELECT 'profile_not_found'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 4. Read program settings
  -- ═══════════════════════════════════════════════════════════════════════════
  SELECT rps.is_enabled INTO v_settings_enabled
  FROM public.referral_program_settings rps
  WHERE rps.id = 1;

  IF NOT FOUND THEN
    v_settings_enabled := FALSE;
  END IF;

  IF v_settings_enabled = FALSE THEN
    RETURN QUERY SELECT 'program_disabled'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 5. Check existing binding
  -- ═══════════════════════════════════════════════════════════════════════════
  SELECT rr.referral_code_snapshot, rr.bound_at INTO v_existing_rel
  FROM public.referral_relationships rr
  WHERE rr.referred_parent_id = v_parent_id;

  IF FOUND THEN
    -- Normalize the submitted code for comparison
    v_normalized := public.normalize_referral_code(p_code);

    IF v_normalized IS NOT NULL AND v_normalized = v_existing_rel.referral_code_snapshot THEN
      RETURN QUERY SELECT 'already_bound_same'::TEXT, v_existing_rel.bound_at;
    ELSE
      RETURN QUERY SELECT 'already_bound_other'::TEXT, v_existing_rel.bound_at;
    END IF;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 6. Rate-limit check (only for non-already-bound attempts)
  -- ═══════════════════════════════════════════════════════════════════════════
  v_allow := public.check_referral_binding_rate_limit(v_parent_id);

  IF NOT v_allow THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 7. Normalize and validate submitted code
  -- ═══════════════════════════════════════════════════════════════════════════
  v_normalized := public.normalize_referral_code(p_code);

  IF v_normalized IS NULL THEN
    RETURN QUERY SELECT 'invalid_code'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 8. Resolve referrer by exact code
  -- ═══════════════════════════════════════════════════════════════════════════
  SELECT pp.id INTO v_referrer_id
  FROM public.parent_profiles pp
  WHERE pp.referral_code = v_normalized;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_code'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 9. Self-referral check (produces same invalid_code result)
  -- ═══════════════════════════════════════════════════════════════════════════
  IF v_referrer_id = v_parent_id THEN
    RETURN QUERY SELECT 'invalid_code'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 10. Insert relationship
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO public.referral_relationships (
    referred_parent_id,
    referrer_parent_id,
    referral_code_snapshot,
    binding_source
  ) VALUES (
    v_parent_id,
    v_referrer_id,
    v_normalized,
    'manual'
  )
  RETURNING referral_relationships.bound_at INTO v_bound_at;

  RETURN QUERY SELECT 'bound'::TEXT, v_bound_at;
END;
$$;

COMMENT ON FUNCTION public.bind_current_parent_referral_code(TEXT)
IS 'One-time permanent referral code binding for the authenticated parent. Idempotent for same-code resubmission. Rate-limited to 5 attempts per minute. Invalid/self/missing codes all return invalid_code.';

REVOKE ALL ON FUNCTION public.bind_current_parent_referral_code(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_current_parent_referral_code(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.bind_current_parent_referral_code(TEXT) TO authenticated;

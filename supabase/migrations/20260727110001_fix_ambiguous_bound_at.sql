-- Fix: Qualify `bound_at` in RETURNING clause to resolve ambiguity with
-- function output column of the same name.

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
    v_normalized := public.normalize_referral_code(p_code);

    IF v_normalized IS NOT NULL AND v_normalized = v_existing_rel.referral_code_snapshot THEN
      RETURN QUERY SELECT 'already_bound_same'::TEXT, v_existing_rel.bound_at;
    ELSE
      RETURN QUERY SELECT 'already_bound_other'::TEXT, v_existing_rel.bound_at;
    END IF;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 6. Rate-limit check
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
  -- 9. Self-referral check
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

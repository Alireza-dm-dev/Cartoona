-- Migration: admin_coupon_management
-- Admin coupon create/update via trusted service-role RPCs.
--
-- Rationale:
--   * coupon tables have SELECT-only RLS for admins (no browser writes).
--   * Admin create/update must go through SECURITY DEFINER RPCs callable only
--     by service_role, mirroring the coupon apply/validate trusted boundary.
--   * The API route authenticates the admin session, resolves the verified
--     admin user id, and passes it to the RPC. The RPC re-verifies the admin
--     role server-side (defense in depth) — it never trusts auth.uid().
--   * Codes are normalized IN THE DATABASE (upper + trim) and validated again.
--   * Package rules are replaced atomically with the coupon row (delete-insert
--     inside the same transaction; no partial state).
--   * Immutability: code / discount type / discount value become immutable once
--     any reserved or redeemed redemption exists. Usage limits cannot be lowered
--     below current usage. Package restrictions affect only future validation
--     (redemptions snapshot their terms), so they remain changeable.
--   * No wallet / purchase / payment / redemption mutation. No seeds.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Shared admin-role check helper (used by both RPCs)
--    Verifies that the passed user id is an admin/super_admin in public.users.
--    Returns TRUE / FALSE. No auth.uid() dependency.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_admin_user_id(p_user_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND role IN ('admin', 'super_admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin_user_id(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_user_id(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.is_admin_user_id(UUID) FROM authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. create_coupon_trusted — admin coupon creation
--    service_role only. Validates, normalizes the code in the database,
--    inserts the coupon and its package rules atomically.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_coupon_trusted(
  p_admin_user_id          UUID,
  p_code                   TEXT,
  p_name                   TEXT,
  p_description            TEXT,
  p_discount_type          TEXT,
  p_discount_value         INTEGER,
  p_is_active              BOOLEAN,
  p_starts_at              TIMESTAMPTZ,
  p_expires_at             TIMESTAMPTZ,
  p_global_usage_limit     INTEGER,
  p_per_parent_usage_limit INTEGER,
  p_minimum_purchase_amount INTEGER,
  p_maximum_discount_amount  INTEGER,
  p_package_ids            UUID[]
)
RETURNS TABLE (coupon_id UUID, code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code        TEXT;
  v_package_id  UUID;
  v_new_id      UUID;
BEGIN
  -- 1. Admin role check
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'coupon_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  -- 2. Normalize + validate code (database is authoritative)
  v_code := upper(trim(p_code));
  IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid coupon code format.';
  END IF;

  -- 3. Name
  IF p_name IS NULL OR char_length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Coupon name is required.';
  END IF;
  IF char_length(trim(p_name)) > 120 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Coupon name too long.';
  END IF;

  -- 4. Discount type + value
  IF p_discount_type NOT IN ('percentage', 'fixed_amount') THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid discount type.';
  END IF;
  IF (p_discount_type = 'percentage'   AND (p_discount_value < 1 OR p_discount_value > 10000))
     OR (p_discount_type = 'fixed_amount' AND (p_discount_value IS NULL OR p_discount_value <= 0)) THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid discount value.';
  END IF;

  -- 5. Date window
  IF p_expires_at IS NOT NULL AND p_starts_at IS NOT NULL AND p_expires_at <= p_starts_at THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'expires_at must be after starts_at.';
  END IF;

  -- 6. Limits
  IF p_global_usage_limit IS NOT NULL AND p_global_usage_limit <= 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid global usage limit.';
  END IF;
  IF p_per_parent_usage_limit IS NOT NULL AND p_per_parent_usage_limit <= 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid per-parent usage limit.';
  END IF;
  IF p_minimum_purchase_amount IS NOT NULL AND p_minimum_purchase_amount < 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid minimum purchase amount.';
  END IF;
  IF p_maximum_discount_amount IS NOT NULL AND p_maximum_discount_amount <= 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid maximum discount amount.';
  END IF;

  -- 7. Duplicate code (uniqueness enforced by UNIQUE constraint as backup)
  IF EXISTS (SELECT 1 FROM public.coupons WHERE code = v_code) THEN
    RAISE EXCEPTION 'coupon_admin_duplicate_code' USING HINT = 'A coupon with this code already exists.';
  END IF;

  -- 8. Validate all supplied package ids exist
  IF p_package_ids IS NOT NULL THEN
    FOREACH v_package_id IN ARRAY p_package_ids
    LOOP
      IF NOT EXISTS (SELECT 1 FROM public.candy_packages WHERE id = v_package_id) THEN
        RAISE EXCEPTION 'coupon_admin_invalid_package' USING HINT = 'A selected package does not exist.';
      END IF;
    END LOOP;
  END IF;

  -- 9. Insert coupon + package rules atomically
  INSERT INTO public.coupons (
    code, name, description, discount_type, discount_value, is_active,
    starts_at, expires_at, global_usage_limit, per_parent_usage_limit,
    minimum_purchase_amount, maximum_discount_amount, created_by_user_id
  ) VALUES (
    v_code, trim(p_name), p_description, p_discount_type, p_discount_value, p_is_active,
    p_starts_at, p_expires_at, p_global_usage_limit, p_per_parent_usage_limit,
    p_minimum_purchase_amount, p_maximum_discount_amount, p_admin_user_id
  )
  RETURNING id INTO v_new_id;

  IF p_package_ids IS NOT NULL THEN
    INSERT INTO public.coupon_package_rules (coupon_id, package_id)
    SELECT DISTINCT v_new_id, x.package_id
    FROM unnest(p_package_ids) AS x(package_id);
  END IF;

  RETURN QUERY SELECT v_new_id, v_code;
END;
$$;

COMMENT ON FUNCTION public.create_coupon_trusted IS
  'Trusted server-only admin coupon creation. Callable only by service_role. '
  'Verifies the passed admin user id is an admin/super_admin, normalizes and '
  'validates the code, validates all fields, inserts the coupon and package '
  'rules atomically. Raises coupon_admin_* codes on failure.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. update_coupon_trusted — admin coupon update
--    service_role only. Optimistic concurrency via expected_updated_at.
--    Immutable: code / discount type / discount value after any reserved or
--    redeemed redemption. Usage limits cannot be lowered below current usage.
--    Package rules are replaced atomically.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_coupon_trusted(
  p_admin_user_id          UUID,
  p_coupon_id              UUID,
  p_expected_updated_at    TIMESTAMPTZ,
  p_code                   TEXT,
  p_name                   TEXT,
  p_description            TEXT,
  p_discount_type          TEXT,
  p_discount_value         INTEGER,
  p_is_active              BOOLEAN,
  p_starts_at              TIMESTAMPTZ,
  p_expires_at             TIMESTAMPTZ,
  p_global_usage_limit     INTEGER,
  p_per_parent_usage_limit INTEGER,
  p_minimum_purchase_amount INTEGER,
  p_maximum_discount_amount  INTEGER,
  p_package_ids            UUID[]
)
RETURNS TABLE (coupon_id UUID, code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current     RECORD;
  v_code        TEXT;
  v_package_id  UUID;
  v_used_global INTEGER;
  v_max_parent_used INTEGER;
BEGIN
  -- 1. Admin role check
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'coupon_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  -- 2. Lock + load current coupon
  SELECT id, code, discount_type, discount_value, updated_at, global_usage_limit, per_parent_usage_limit
    INTO v_current
  FROM public.coupons
  WHERE id = p_coupon_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_admin_not_found' USING HINT = 'Coupon not found.';
  END IF;

  -- 3. Optimistic concurrency — exact match, no last-write-wins
  IF v_current.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'coupon_admin_conflict' USING HINT = 'The coupon changed since it was loaded.';
  END IF;

  -- 4. Normalize + validate code (database is authoritative)
  v_code := upper(trim(p_code));
  IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid coupon code format.';
  END IF;

  -- 5. Name
  IF p_name IS NULL OR char_length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Coupon name is required.';
  END IF;
  IF char_length(trim(p_name)) > 120 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Coupon name too long.';
  END IF;

  -- 6. Discount type + value
  IF p_discount_type NOT IN ('percentage', 'fixed_amount') THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid discount type.';
  END IF;
  IF (p_discount_type = 'percentage'   AND (p_discount_value < 1 OR p_discount_value > 10000))
     OR (p_discount_type = 'fixed_amount' AND (p_discount_value IS NULL OR p_discount_value <= 0)) THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid discount value.';
  END IF;

  -- 7. Date window
  IF p_expires_at IS NOT NULL AND p_starts_at IS NOT NULL AND p_expires_at <= p_starts_at THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'expires_at must be after starts_at.';
  END IF;

  -- 8. Limits
  IF p_global_usage_limit IS NOT NULL AND p_global_usage_limit <= 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid global usage limit.';
  END IF;
  IF p_per_parent_usage_limit IS NOT NULL AND p_per_parent_usage_limit <= 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid per-parent usage limit.';
  END IF;
  IF p_minimum_purchase_amount IS NOT NULL AND p_minimum_purchase_amount < 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid minimum purchase amount.';
  END IF;
  IF p_maximum_discount_amount IS NOT NULL AND p_maximum_discount_amount <= 0 THEN
    RAISE EXCEPTION 'coupon_admin_invalid' USING HINT = 'Invalid maximum discount amount.';
  END IF;

  -- 9. Immutability: code / discount type / value locked after any usage.
  --    usage = reserved + redeemed (cancelled does not count).
  SELECT count(*) INTO v_used_global
  FROM public.coupon_redemptions
  WHERE coupon_id = p_coupon_id AND status IN ('reserved', 'redeemed');

  IF v_used_global > 0 THEN
    IF v_current.code IS DISTINCT FROM v_code
       OR v_current.discount_type IS DISTINCT FROM p_discount_type
       OR v_current.discount_value IS DISTINCT FROM p_discount_value THEN
      RAISE EXCEPTION 'coupon_admin_immutable_discount'
        USING HINT = 'Discount code/type/value cannot change after usage.';
    END IF;
  END IF;

  -- 10. Usage-limit safety: never lower below current usage.
  IF p_global_usage_limit IS NOT NULL AND p_global_usage_limit < v_used_global THEN
    RAISE EXCEPTION 'coupon_admin_usage_limit_conflict'
      USING HINT = 'New global limit is below current usage.';
  END IF;

  SELECT COALESCE(max(cnt), 0) INTO v_max_parent_used
  FROM (
    SELECT count(*) AS cnt
    FROM public.coupon_redemptions
    WHERE coupon_id = p_coupon_id AND status IN ('reserved', 'redeemed')
    GROUP BY parent_profile_id
  ) AS per_parent;

  IF p_per_parent_usage_limit IS NOT NULL AND p_per_parent_usage_limit < v_max_parent_used THEN
    RAISE EXCEPTION 'coupon_admin_usage_limit_conflict'
      USING HINT = 'New per-parent limit is below current usage.';
  END IF;

  -- 11. Duplicate code (excluding self)
  IF EXISTS (SELECT 1 FROM public.coupons WHERE code = v_code AND id <> p_coupon_id) THEN
    RAISE EXCEPTION 'coupon_admin_duplicate_code' USING HINT = 'A coupon with this code already exists.';
  END IF;

  -- 12. Validate all supplied package ids exist
  IF p_package_ids IS NOT NULL THEN
    FOREACH v_package_id IN ARRAY p_package_ids
    LOOP
      IF NOT EXISTS (SELECT 1 FROM public.candy_packages WHERE id = v_package_id) THEN
        RAISE EXCEPTION 'coupon_admin_invalid_package' USING HINT = 'A selected package does not exist.';
      END IF;
    END LOOP;
  END IF;

  -- 13. Update coupon row + replace package rules atomically.
  UPDATE public.coupons
  SET code = v_code,
      name = trim(p_name),
      description = p_description,
      discount_type = p_discount_type,
      discount_value = p_discount_value,
      is_active = p_is_active,
      starts_at = p_starts_at,
      expires_at = p_expires_at,
      global_usage_limit = p_global_usage_limit,
      per_parent_usage_limit = p_per_parent_usage_limit,
      minimum_purchase_amount = p_minimum_purchase_amount,
      maximum_discount_amount = p_maximum_discount_amount
  WHERE id = p_coupon_id;

  DELETE FROM public.coupon_package_rules WHERE coupon_id = p_coupon_id;
  IF p_package_ids IS NOT NULL THEN
    INSERT INTO public.coupon_package_rules (coupon_id, package_id)
    SELECT DISTINCT p_coupon_id, x.package_id
    FROM unnest(p_package_ids) AS x(package_id);
  END IF;

  RETURN QUERY SELECT p_coupon_id, v_code;
END;
$$;

COMMENT ON FUNCTION public.update_coupon_trusted IS
  'Trusted server-only admin coupon update. Callable only by service_role. '
  'Verifies the passed admin user id, locks the coupon FOR UPDATE, enforces '
  'optimistic concurrency (coupon_admin_conflict on mismatch), validates all '
  'fields, rejects immutable discount changes after usage, rejects usage-limit '
  'reductions below current usage, and replaces package rules atomically. '
  'Raises coupon_admin_* codes on failure.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. RPC execution privileges — service_role only
--    Browser roles (anon, authenticated) can never execute admin coupon
--    mutations. Reads continue through admin SELECT-only RLS policies.
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.create_coupon_trusted(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ,
  INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_coupon_trusted(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ,
  INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) FROM anon;
REVOKE ALL ON FUNCTION public.create_coupon_trusted(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ,
  INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_coupon_trusted(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ,
  INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) TO service_role;

REVOKE ALL ON FUNCTION public.update_coupon_trusted(
  UUID, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN,
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_coupon_trusted(
  UUID, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN,
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) FROM anon;
REVOKE ALL ON FUNCTION public.update_coupon_trusted(
  UUID, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN,
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_coupon_trusted(
  UUID, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, BOOLEAN,
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, UUID[]
) TO service_role;

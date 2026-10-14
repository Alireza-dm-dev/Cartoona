-- Cartoona plain-PostgreSQL baseline (V0.1.38) - transaction-critical business functions
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- Every function here takes its actor explicitly (a parent profile id or an
-- admin user id that the backend has already authenticated) instead of
-- reading a database session claim. They remain SECURITY DEFINER with an
-- empty search_path, so a restricted application role can be granted EXECUTE
-- on them without direct write access to the tables they change.

CREATE FUNCTION public.apply_coupon_to_purchase_trusted(p_parent_profile_id uuid, p_purchase_id uuid, p_coupon_code text, p_idempotency_key text) RETURNS TABLE(redemption_id uuid, coupon_id uuid, normalized_code text, discount_type text, discount_value integer, original_price_amount integer, discount_amount integer, final_price_amount integer, currency text, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_code           TEXT;
  v_purchase_parent_id UUID;
  v_purchase_status    TEXT;
  v_original_price     INTEGER;
  v_currency           TEXT;
  v_package_id         UUID;
  v_active_attempt_id  UUID;
  v_coupon_id          UUID;
  v_discount_type      TEXT;
  v_discount_value     INTEGER;
  v_is_active          BOOLEAN;
  v_starts_at          TIMESTAMPTZ;
  v_expires_at         TIMESTAMPTZ;
  v_global_limit       INTEGER;
  v_parent_limit       INTEGER;
  v_minimum_amount     INTEGER;
  v_maximum_discount   INTEGER;
  v_used_global        INTEGER;
  v_used_parent        INTEGER;
  v_rule_count         INTEGER;
  v_discount           INTEGER;
  v_final              INTEGER;
  v_existing_redemption_id UUID;
  v_existing_key       TEXT;
  v_redemption_id      UUID;
BEGIN
  -- 1. Input validation
  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'coupon_parent_required' USING HINT = 'Parent profile ID is required.';
  END IF;
  IF p_purchase_id IS NULL THEN
    RAISE EXCEPTION 'coupon_purchase_required' USING HINT = 'Purchase ID is required.';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'coupon_idempotency_required' USING HINT = 'Idempotency key is required.';
  END IF;
  IF char_length(trim(p_idempotency_key)) > 255 THEN
    RAISE EXCEPTION 'coupon_idempotency_too_long' USING HINT = 'Idempotency key must not exceed 255 characters.';
  END IF;

  -- 2. Normalize the code.
  v_code := upper(trim(p_coupon_code));
  IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RAISE EXCEPTION 'coupon_code_invalid' USING HINT = 'The coupon code format is invalid.';
  END IF;

  -- 3. Lock the purchase FOR UPDATE (serializes coupon apply per purchase).
  SELECT parent_id, status, original_price_amount, currency, package_id, active_payment_attempt_id
    INTO v_purchase_parent_id, v_purchase_status, v_original_price, v_currency,
         v_package_id, v_active_attempt_id
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_purchase_not_found' USING HINT = 'Purchase record not found.';
  END IF;

  -- 4. Ownership
  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'coupon_purchase_not_owner' USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- 5. Status pending
  IF v_purchase_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'coupon_purchase_not_pending' USING HINT = 'Only pending purchases accept a coupon.';
  END IF;

  -- 6. No payment attempt yet.
  IF v_active_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'coupon_purchase_has_payment_attempt'
      USING HINT = 'A payment attempt already exists for this purchase.';
  END IF;

  -- 7. Idempotency: same (purchase_id, idempotency_key) returns existing row.
  SELECT id INTO v_existing_redemption_id
  FROM public.coupon_redemptions
  WHERE purchase_id = p_purchase_id AND idempotency_key = p_idempotency_key;

  IF v_existing_redemption_id IS NOT NULL THEN
    RETURN QUERY
    SELECT cr.id, cr.coupon_id, cr.normalized_code_snapshot, cr.discount_type_snapshot,
           cr.discount_value_snapshot, cr.original_price_amount, cr.discount_amount,
           cr.final_price_amount, cr.currency, cr.status
    FROM public.coupon_redemptions cr
    WHERE cr.id = v_existing_redemption_id;
    RETURN;
  END IF;

  -- 8. Reject a DIFFERENT coupon on an already-discounted purchase.
  SELECT id INTO v_existing_redemption_id
  FROM public.coupon_redemptions
  WHERE purchase_id = p_purchase_id AND status IN ('reserved', 'redeemed');

  IF v_existing_redemption_id IS NOT NULL THEN
    RAISE EXCEPTION 'coupon_already_applied' USING HINT = 'A coupon is already applied to this purchase.';
  END IF;

  -- 9. Load coupon and re-validate everything inside this transaction.
  SELECT id, discount_type, discount_value, is_active, starts_at, expires_at,
         global_usage_limit, per_parent_usage_limit, minimum_purchase_amount,
         maximum_discount_amount
    INTO v_coupon_id, v_discount_type, v_discount_value, v_is_active, v_starts_at,
         v_expires_at, v_global_limit, v_parent_limit, v_minimum_amount, v_maximum_discount
  FROM public.coupons
  WHERE code = v_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_not_found' USING HINT = 'No such coupon code.';
  END IF;

  IF NOT v_is_active THEN
    RAISE EXCEPTION 'coupon_inactive' USING HINT = 'The coupon is not active.';
  END IF;
  IF v_starts_at IS NOT NULL AND now() < v_starts_at THEN
    RAISE EXCEPTION 'coupon_not_started' USING HINT = 'The coupon has not started yet.';
  END IF;
  IF v_expires_at IS NOT NULL AND now() > v_expires_at THEN
    RAISE EXCEPTION 'coupon_expired' USING HINT = 'The coupon has expired.';
  END IF;

  SELECT count(*) INTO v_used_global
  FROM public.coupon_redemptions
  WHERE coupon_id = v_coupon_id AND status IN ('reserved', 'redeemed');

  IF v_global_limit IS NOT NULL AND v_used_global >= v_global_limit THEN
    RAISE EXCEPTION 'coupon_usage_limit_reached' USING HINT = 'The global usage limit is reached.';
  END IF;

  SELECT count(*) INTO v_used_parent
  FROM public.coupon_redemptions
  WHERE coupon_id = v_coupon_id
    AND parent_profile_id = p_parent_profile_id
    AND status IN ('reserved', 'redeemed');

  IF v_parent_limit IS NOT NULL AND v_used_parent >= v_parent_limit THEN
    RAISE EXCEPTION 'coupon_parent_limit_reached' USING HINT = 'The per-parent usage limit is reached.';
  END IF;

  SELECT count(*) INTO v_rule_count
  FROM public.coupon_package_rules
  WHERE coupon_id = v_coupon_id;

  IF v_rule_count > 0 THEN
    PERFORM 1
    FROM public.coupon_package_rules
    WHERE coupon_id = v_coupon_id AND package_id = v_package_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'coupon_package_not_eligible' USING HINT = 'This coupon does not apply to the selected package.';
    END IF;
  END IF;

  IF v_minimum_amount IS NOT NULL AND v_original_price < v_minimum_amount THEN
    RAISE EXCEPTION 'coupon_minimum_not_met' USING HINT = 'The minimum purchase amount is not met.';
  END IF;

  -- 10. Recompute discount in the same transaction.
  v_discount := public.calculate_coupon_discount(
    v_discount_type, v_discount_value, v_original_price, v_maximum_discount
  );

  IF v_discount <= 0 THEN
    RAISE EXCEPTION 'coupon_zero_discount'
      USING HINT = 'This coupon produces no discount for this purchase amount.';
  END IF;

  v_final := v_original_price - v_discount;

  -- 11. Record the redemption with full snapshots (status reserved).
  INSERT INTO public.coupon_redemptions (
    coupon_id, purchase_id, parent_profile_id,
    normalized_code_snapshot, discount_type_snapshot, discount_value_snapshot,
    original_price_amount, discount_amount, final_price_amount, currency,
    status, idempotency_key
  ) VALUES (
    v_coupon_id, p_purchase_id, p_parent_profile_id,
    v_code, v_discount_type, v_discount_value,
    v_original_price, v_discount, v_final, v_currency,
    'reserved', p_idempotency_key
  )
  RETURNING id INTO v_redemption_id;

  -- 12. Update purchase discount/final amounts (atomic with the insert).
  UPDATE public.candy_purchases
  SET discount_amount    = v_discount,
      final_price_amount = v_final
  WHERE id = p_purchase_id;

  -- 13. Return the applied result.
  RETURN QUERY
  SELECT v_redemption_id, v_coupon_id, v_code, v_discount_type, v_discount_value,
         v_original_price, v_discount, v_final, v_currency, 'reserved'::TEXT;
END;
$_$;

COMMENT ON FUNCTION public.apply_coupon_to_purchase_trusted IS 'Trusted server-only, atomic coupon application. Callable only by the backend (EXECUTE is not granted to PUBLIC). Locks the purchase FOR UPDATE, re-validates the coupon inside the transaction, inserts the redemption row (status=reserved) with snapshots, and updates candy_purchases discount_amount/final_price_amount. Idempotent: retrying with the same (purchase_id, idempotency_key) returns the existing redemption. A different coupon on an already-discounted purchase is rejected. Does NOT create a payment attempt and does NOT touch the wallet or ledger.';

CREATE FUNCTION public.approve_final_media_trusted(p_admin_user_id uuid, p_asset_id uuid, p_order_id uuid) RETURNS TABLE(asset_id uuid, asset_role text, delivery_status text, parent_visible boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_role     TEXT;
  v_delivery TEXT;
  v_order_id UUID;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  SELECT ma.asset_role, ma.delivery_status, ma.order_id
    INTO v_role, v_delivery, v_order_id
  FROM public.media_assets ma
  WHERE ma.id = p_asset_id
  FOR UPDATE;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset not found.';
  END IF;
  IF v_order_id IS DISTINCT FROM p_order_id THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset does not belong to this order.';
  END IF;
  IF v_role <> 'final' THEN
    RAISE EXCEPTION 'request_asset_not_final' USING HINT = 'Only final assets can be approved.';
  END IF;
  IF v_delivery IS DISTINCT FROM 'uploaded' THEN
    RAISE EXCEPTION 'request_asset_not_uploaded'
      USING HINT = 'Only uploaded assets can be approved for parent visibility.';
  END IF;

  UPDATE public.media_assets
  SET delivery_status = 'approved',
      parent_visible  = TRUE
  WHERE id = p_asset_id;

  RETURN QUERY
  SELECT p_asset_id, v_role, 'approved'::TEXT, TRUE;
END;
$$;

COMMENT ON FUNCTION public.approve_final_media_trusted IS 'Trusted service-role-only approval: marks an uploaded final asset as approved and parent-visible. Requires the asset to belong to the given order.';

CREATE FUNCTION public.bind_parent_referral_code_trusted(p_user_id uuid, p_code text) RETURNS TABLE(status text, bound_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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
  -- 1. Caller identity - authenticated and session-checked by the backend
  -- ═══════════════════════════════════════════════════════════════════════════
  v_user_id := p_user_id;
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

COMMENT ON FUNCTION public.bind_parent_referral_code_trusted IS 'One-time permanent referral code binding for the authenticated parent. Idempotent for same-code resubmission. Rate-limited to 5 attempts per minute. Invalid/self/missing codes all return invalid_code.';

CREATE FUNCTION public.complete_candy_purchase_trusted(p_purchase_id uuid, p_parent_profile_id uuid, p_payment_reference text) RETURNS TABLE(purchase_id uuid, purchase_status text, wallet_id uuid, wallet_balance integer, ledger_entry_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_purchase_parent_id UUID;
  v_purchase_status    TEXT;
  v_candy_amount       INTEGER;
  v_wallet_id          UUID;
  v_ledger_id          UUID;
  v_existing_ledger_id UUID;
  v_credit_key         TEXT;
BEGIN
  -- ═════════════════════════════════════════════════════════════════════════
  -- 1. Lock purchase row FOR UPDATE
  -- ═════════════════════════════════════════════════════════════════════════
  SELECT parent_id, status, candy_amount
    INTO v_purchase_parent_id, v_purchase_status, v_candy_amount
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_not_found'
      USING HINT = 'Purchase record not found.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 2. Ownership verification
  --    The parent_profile_id was already verified by the API route through
  --    the authenticated session. We double-check the purchase belongs to
  --    this parent before proceeding.
  -- ═════════════════════════════════════════════════════════════════════════
  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'purchase_not_owner'
      USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 3. Status check — only pending purchases may be completed
  -- ═════════════════════════════════════════════════════════════════════════
  IF v_purchase_status IS DISTINCT FROM 'pending' THEN
    IF v_purchase_status = 'paid' THEN
      -- Idempotent return: already paid, return current state
      v_credit_key := 'purchase_credit:' || p_purchase_id;
      SELECT id INTO v_existing_ledger_id
      FROM public.candy_transactions
      WHERE idempotency_key = v_credit_key;

      IF v_existing_ledger_id IS NOT NULL THEN
        RETURN QUERY
        SELECT
          p_purchase_id,
          'paid'::TEXT,
          cw.id,
          cw.balance,
          v_existing_ledger_id
        FROM public.candy_wallets cw
        WHERE cw.parent_id = p_parent_profile_id;
        RETURN;
      END IF;
    END IF;

    RAISE EXCEPTION 'purchase_not_pending'
      USING HINT = 'Only pending purchases can be completed.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 4. Mark purchase as paid
  -- ═════════════════════════════════════════════════════════════════════════
  UPDATE public.candy_purchases
  SET status = 'paid',
      payment_reference = COALESCE(p_payment_reference, payment_reference),
      paid_at = now()
  WHERE id = p_purchase_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 5. Lock wallet and credit balance
  -- ═════════════════════════════════════════════════════════════════════════
  SELECT id INTO v_wallet_id
  FROM public.candy_wallets
  WHERE parent_id = p_parent_profile_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_wallet_not_found'
      USING HINT = 'Candy wallet not found.';
  END IF;

  UPDATE public.candy_wallets
  SET balance = balance + v_candy_amount
  WHERE id = v_wallet_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 6. Insert immutable ledger entry
  -- ═════════════════════════════════════════════════════════════════════════
  v_credit_key := 'purchase_credit:' || p_purchase_id;

  INSERT INTO public.candy_transactions (
    wallet_id,
    amount,
    type,
    reference_type,
    reference_id,
    description,
    idempotency_key
  ) VALUES (
    v_wallet_id,
    v_candy_amount,
    'purchase',
    'candy_purchase',
    p_purchase_id::TEXT,
    'اعتبار آبنبات بسته خریداری شده',
    v_credit_key
  )
  RETURNING id INTO v_ledger_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 7. Return updated state
  -- ═════════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT
    p_purchase_id,
    'paid'::TEXT,
    v_wallet_id,
    (SELECT balance FROM public.candy_wallets WHERE id = v_wallet_id),
    v_ledger_id;
END;
$$;

COMMENT ON FUNCTION public.complete_candy_purchase_trusted IS 'Trusted server-only purchase completion. Callable only by the backend (EXECUTE is not granted to PUBLIC). Accepts a verified parent_profile_id from the API route instead of reading a session claim. Forwards to wallet credit and immutable ledger insertion. Idempotent — calling again with the same purchase_id returns current state.';

CREATE FUNCTION public.create_coupon_trusted(p_admin_user_id uuid, p_code text, p_name text, p_description text, p_discount_type text, p_discount_value integer, p_is_active boolean, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_global_usage_limit integer, p_per_parent_usage_limit integer, p_minimum_purchase_amount integer, p_maximum_discount_amount integer, p_package_ids uuid[]) RETURNS TABLE(coupon_id uuid, code text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
#variable_conflict use_column
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
$_$;

COMMENT ON FUNCTION public.create_coupon_trusted IS 'Trusted server-only admin coupon creation. Callable only by the backend (EXECUTE is not granted to PUBLIC). Verifies the passed admin user id is an admin/super_admin, normalizes and validates the code, validates all fields, inserts the coupon and package rules atomically. Raises coupon_admin_* codes on failure.';

CREATE FUNCTION public.create_parent_request_trusted(p_parent_profile_id uuid, p_order_id uuid, p_type text, p_title text, p_description text DEFAULT NULL::text, p_character_id uuid DEFAULT NULL::uuid, p_duration_key text DEFAULT NULL::text, p_video_script text DEFAULT NULL::text, p_video_style text DEFAULT NULL::text, p_animation_style text DEFAULT NULL::text, p_file_path text DEFAULT NULL::text, p_duration_choice text DEFAULT NULL::text, p_characters_speak boolean DEFAULT NULL::boolean, p_child_name text DEFAULT NULL::text, p_original_filename text DEFAULT NULL::text, p_submission_key uuid DEFAULT NULL::uuid, p_file_mime_type text DEFAULT NULL::text) RETURNS TABLE(id uuid, type text, status text, candy_cost integer, replayed boolean, payment_source text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_parent_id      UUID;
  v_user_id        UUID;
  v_candy_cost     INTEGER;
  v_has_file       BOOLEAN;
  v_trusted_mime   TEXT;
  v_wallet_id      UUID;
  v_wallet_balance INTEGER;
  v_pricing_keys   TEXT[];
  v_found_count    INTEGER;
  v_order_id       UUID;
  v_replayed       BOOLEAN := FALSE;
  v_use_credit     BOOLEAN := FALSE;
  v_credit_left    INTEGER;
  v_pay_source     TEXT := 'candy';
  v_charge         INTEGER;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Trusted parent profile resolution
  --    The API route authenticated the caller and resolved this ID from the
  --    parent session. We re-verify the profile exists and consent is granted
  --    (defense in depth — the caller is server-side, but we never trust
  --    client claims blindly).
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'request_parent_profile_missing'
      USING HINT = 'Parent profile not found.';
  END IF;

  SELECT pp.id, pp.user_id
  INTO v_parent_id, v_user_id
  FROM public.parent_profiles pp
  WHERE pp.id = p_parent_profile_id;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'request_parent_profile_missing'
      USING HINT = 'Parent profile not found.';
  END IF;

  -- Reject admin / super_admin callers
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.role IN ('admin', 'super_admin')) THEN
    RAISE EXCEPTION 'request_parent_required'
      USING HINT = 'Only parent accounts can create requests.';
  END IF;

  -- Verify role is parent
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.role = 'parent') THEN
    RAISE EXCEPTION 'request_parent_required'
      USING HINT = 'Parent role required.';
  END IF;

  -- Verify consent is still granted
  IF NOT EXISTS (SELECT 1 FROM public.parent_profiles pp WHERE pp.id = v_parent_id AND pp.consent_granted = TRUE) THEN
    RAISE EXCEPTION 'request_consent_required'
      USING HINT = 'Parent consent must be granted.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1b. Idempotency fast path
  --     Checked before any validation, pricing lookup, or wallet lock so a
  --     plain retry of an already-succeeded submission does none of that work
  --     and cannot fail for a reason the first attempt already got past. Scoped
  --     to v_parent_id — resolved above from the trusted profile id, never
  --     from client input — so one parent can never retrieve another parent's
  --     order by reusing or guessing a submission key.
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_submission_key IS NOT NULL THEN
    SELECT o.id INTO v_order_id
    FROM public.orders o
    WHERE o.parent_id = v_parent_id
      AND o.submission_key = p_submission_key;

    IF v_order_id IS NOT NULL THEN
      v_replayed := TRUE;
    END IF;
  END IF;

  IF NOT v_replayed THEN
    -- ═══════════════════════════════════════════════════════════════════════════
    -- 2. Order ID validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_order_id IS NULL THEN
      RAISE EXCEPTION 'request_invalid_order_id'
        USING HINT = 'Order ID is required.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 3. Type validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type NOT IN ('image', 'video', 'drawing_animation') THEN
      RAISE EXCEPTION 'request_invalid_type'
        USING HINT = 'Type must be image, video, or drawing_animation.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 4. Text validation
    -- ═══════════════════════════════════════════════════════════════════════════
    -- Title is optional. Image and video requests no longer collect one, and a
    -- placeholder is never substituted: the column is nullable and the read
    -- models fall back at display time. Drawing animation still sends a title,
    -- which the API route continues to require.
    IF p_title IS NOT NULL AND char_length(p_title) > 160 THEN
      RAISE EXCEPTION 'request_title_too_long'
        USING HINT = 'Title must not exceed 160 characters.';
    END IF;

    IF p_description IS NOT NULL AND char_length(p_description) > 5000 THEN
      RAISE EXCEPTION 'request_description_too_long'
        USING HINT = 'Description must not exceed 5000 characters.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 5. Character validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type IN ('image', 'video') THEN
      -- Character is required for image and video
      IF p_character_id IS NULL THEN
        RAISE EXCEPTION 'request_character_required'
          USING HINT = 'Character is required for image and video requests.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = p_character_id AND c.is_active = TRUE) THEN
        RAISE EXCEPTION 'request_character_invalid'
          USING HINT = 'Character must exist and be active.';
      END IF;
    ELSIF p_type = 'drawing_animation' THEN
      -- Character must be null for drawing animation
      IF p_character_id IS NOT NULL THEN
        RAISE EXCEPTION 'request_character_not_allowed'
          USING HINT = 'Drawing animation requests must not include a character.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 6. Duration validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type IN ('video', 'drawing_animation') THEN
      IF p_duration_key IS NULL OR p_duration_key NOT IN ('short', 'medium', 'long') THEN
        RAISE EXCEPTION 'request_invalid_duration'
          USING HINT = 'Duration must be short, medium, or long.';
      END IF;
    ELSIF p_type = 'image' THEN
      IF p_duration_key IS NOT NULL THEN
        RAISE EXCEPTION 'request_duration_not_allowed'
          USING HINT = 'Image requests must not include a duration.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 7. Type-specific field validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type = 'video' THEN
      IF p_video_script IS NULL OR char_length(trim(p_video_script)) = 0 THEN
        RAISE EXCEPTION 'request_script_required'
          USING HINT = 'Video script is required.';
      END IF;
      IF char_length(p_video_script) > 5000 THEN
        RAISE EXCEPTION 'request_script_too_long'
          USING HINT = 'Video script must not exceed 5000 characters.';
      END IF;
      -- Style is optional: the parent form no longer asks for it. Historical
      -- rows keep the value they were created with.
      IF p_video_style IS NOT NULL AND char_length(p_video_style) > 200 THEN
        RAISE EXCEPTION 'request_style_too_long'
          USING HINT = 'Video style must not exceed 200 characters.';
      END IF;
      IF p_animation_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_animation_style_not_allowed'
          USING HINT = 'Video requests must not include an animation style.';
      END IF;

      -- Parent-facing duration choice. Required, and must agree with the
      -- pricing tier the caller asked for, so the tier cannot be selected
      -- independently of what the parent actually chose.
      IF p_duration_choice IS NULL OR p_duration_choice NOT IN ('5_10', '10_20', '30_plus') THEN
        RAISE EXCEPTION 'request_invalid_duration_choice'
          USING HINT = 'Duration choice must be 5_10, 10_20, or 30_plus.';
      END IF;

      -- Spelled out rather than as a CASE expression: plpgsql ends an IF
      -- condition at the first THEN it sees, so a CASE cannot appear here.
      IF NOT (
        (p_duration_choice = '5_10' AND p_duration_key = 'short')
        OR (p_duration_choice = '10_20' AND p_duration_key = 'medium')
        OR (p_duration_choice = '30_plus' AND p_duration_key = 'long')
      ) THEN
        RAISE EXCEPTION 'request_invalid_duration_choice'
          USING HINT = 'Duration choice does not match the pricing tier.';
      END IF;

      -- Explicit yes/no, never inferred. Historical rows stay NULL.
      IF p_characters_speak IS NULL THEN
        RAISE EXCEPTION 'request_characters_speak_required'
          USING HINT = 'Characters-speak selection is required for video requests.';
      END IF;
    ELSIF p_type = 'drawing_animation' THEN
      IF p_animation_style IS NULL OR char_length(trim(p_animation_style)) = 0 THEN
        RAISE EXCEPTION 'request_animation_style_required'
          USING HINT = 'Animation style is required for drawing animation requests.';
      END IF;
      IF char_length(p_animation_style) > 200 THEN
        RAISE EXCEPTION 'request_animation_style_too_long'
          USING HINT = 'Animation style must not exceed 200 characters.';
      END IF;
      IF p_video_script IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_script_not_allowed'
          USING HINT = 'Drawing animation requests must not include a video script.';
      END IF;
      IF p_video_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_style_not_allowed'
          USING HINT = 'Drawing animation requests must not include a video style.';
      END IF;
    ELSIF p_type = 'image' THEN
      IF p_video_script IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_script_not_allowed';
      END IF;
      IF p_video_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_style_not_allowed';
      END IF;
      IF p_animation_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_animation_style_not_allowed';
      END IF;
    END IF;

    IF p_type <> 'video' THEN
      IF p_duration_choice IS NOT NULL THEN
        RAISE EXCEPTION 'request_duration_choice_not_allowed'
          USING HINT = 'Only video requests carry a duration choice.';
      END IF;
      IF p_characters_speak IS NOT NULL THEN
        RAISE EXCEPTION 'request_characters_speak_not_allowed'
          USING HINT = 'Only video requests carry a characters-speak selection.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 7b. Child name validation
    --     Optional for every request type. Only a length ceiling is enforced
    --     here; the shape rules live with the form, and a historical row that
    --     predates the column simply stays NULL.
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_child_name IS NOT NULL AND char_length(trim(p_child_name)) > 60 THEN
      RAISE EXCEPTION 'request_child_name_too_long'
        USING HINT = 'Child name must not exceed 60 characters.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 8. Source file validation and MIME derivation
    -- ═══════════════════════════════════════════════════════════════════════════
    v_has_file := p_file_path IS NOT NULL;

    IF v_has_file THEN
      -- Reject leading slash (absolute path)
      IF p_file_path LIKE '/%' THEN
        RAISE EXCEPTION 'request_invalid_file_path'
          USING HINT = 'File path must not be absolute.';
      END IF;

      -- Reject path traversal
      IF p_file_path LIKE '%/../%' OR p_file_path LIKE '../%' OR p_file_path LIKE '%/..' OR p_file_path = '..' THEN
        RAISE EXCEPTION 'request_invalid_file_path'
          USING HINT = 'File path must not contain path traversal.';
      END IF;

      -- Path must start with <real-auth-uid>/<order-id>/
      -- v_user_id is derived from parent_profiles.user_id, so uploads are
      -- bound to the parent's real auth identity — never a client-supplied value.
      IF p_file_path NOT LIKE (v_user_id::text || '/' || p_order_id::text || '/%') THEN
        RAISE EXCEPTION 'request_invalid_file_path'
          USING HINT = 'File path must start with the authenticated user ID and order ID.';
      END IF;

      -- Plain-PostgreSQL contract (V0.1.38): the database no longer reads
      -- the storage provider. BEFORE calling, the backend must have verified
      -- that the object at p_file_path exists in the private uploads bucket,
      -- that its upload completed, and that it belongs to this parent/order;
      -- p_file_mime_type is the MIME type the backend read from the provider's
      -- object metadata - never a client-supplied value. Path shape, owner
      -- prefix and the MIME allow-list are still enforced here.
      v_trusted_mime := p_file_mime_type;

      IF v_trusted_mime IS NULL THEN
        RAISE EXCEPTION 'request_file_not_found'
          USING HINT = 'Verified source file metadata is required.';
      END IF;

      -- Must be an allowed image MIME type
      IF v_trusted_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
        RAISE EXCEPTION 'request_file_type_invalid'
          USING HINT = 'Source file must be JPEG, PNG, or WebP.';
      END IF;

      -- Drawing animation requires a source file
      IF p_type = 'drawing_animation' AND v_trusted_mime IS NULL THEN
        RAISE EXCEPTION 'request_file_required'
          USING HINT = 'Drawing animation requests require a source file.';
      END IF;
    ELSE
      -- Drawing animation requires a file
      IF p_type = 'drawing_animation' THEN
        RAISE EXCEPTION 'request_file_required'
          USING HINT = 'Drawing animation requests require a source file.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 9. Derive pricing keys from validated request metadata
    --     Maps request type + duration + file presence to stable catalog keys.
    --     No numeric prices appear in this section.
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type = 'image' THEN
      v_pricing_keys := CASE WHEN v_has_file
        THEN ARRAY['image.default', 'image.reference_file']
        ELSE ARRAY['image.default'] END;
    ELSIF p_type = 'video' THEN
      v_pricing_keys := CASE p_duration_key
        WHEN 'short' THEN ARRAY['video.short']
        WHEN 'medium' THEN ARRAY['video.medium']
        ELSE ARRAY['video.long'] END;
      IF v_has_file THEN
        v_pricing_keys := v_pricing_keys || ARRAY['video.reference_file'];
      END IF;
    ELSIF p_type = 'drawing_animation' THEN
      v_pricing_keys := CASE p_duration_key
        WHEN 'short' THEN ARRAY['drawing_animation.short']
        WHEN 'medium' THEN ARRAY['drawing_animation.medium']
        ELSE ARRAY['drawing_animation.long'] END;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 10. Look up active catalog prices
    --     All required keys must exist, be active, and sum to a positive total.
    --     Missing / inactive / invalid pricing fails closed.
    -- ═══════════════════════════════════════════════════════════════════════════
    SELECT
      pg_catalog.count(*),
      pg_catalog.sum(cp.candy_cost)
    INTO
      v_found_count,
      v_candy_cost
    FROM public.creation_pricing AS cp
    WHERE cp.pricing_key = ANY(v_pricing_keys)
      AND cp.is_active = TRUE;

    IF v_found_count IS NULL OR v_found_count <> pg_catalog.cardinality(v_pricing_keys) THEN
      RAISE EXCEPTION 'CREATION_PRICING_UNAVAILABLE'
        USING HINT = 'قیمت این درخواست در حال حاضر در دسترس نیست.';
    END IF;

    IF v_candy_cost IS NULL OR v_candy_cost <= 0 THEN
      RAISE EXCEPTION 'CREATION_PRICING_UNAVAILABLE'
        USING HINT = 'قیمت این درخواست در حال حاضر در دسترس نیست.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 11. Wallet resolution and row lock
    -- ═══════════════════════════════════════════════════════════════════════════
    SELECT cw.id, cw.balance
    INTO v_wallet_id, v_wallet_balance
    FROM public.candy_wallets cw
    WHERE cw.parent_id = v_parent_id
    FOR UPDATE;

    IF v_wallet_id IS NULL THEN
      RAISE EXCEPTION 'CANDY_WALLET_NOT_FOUND'
        USING HINT = 'کیف پول آبنبات در دسترس نیست.';
    END IF;

    <<charge_and_create>>
    BEGIN
      -- ═════════════════════════════════════════════════════════════════════════
      -- 11b. Replay re-check, now that this parent's wallet row is locked.
      --      Every submission by one parent serialises on the wallet lock above.
      --      A concurrent call for the SAME submission_key that was ahead of us
      --      has therefore committed by now, and its order is visible here. Without
      --      this, the loser of that race would reach the balance check below
      --      AFTER the winner spent the last credit / candy and fail with
      --      INSUFFICIENT_* instead of replaying the winner's order. (The fast
      --      path in 1b ran before the lock and cannot see an order that was still
      --      in flight.) The ON CONFLICT insert further down remains the final
      --      guarantee; this only makes the loser answer correctly.
      -- ═════════════════════════════════════════════════════════════════════════
      IF p_submission_key IS NOT NULL THEN
        SELECT o.id INTO v_order_id
        FROM public.orders o
        WHERE o.parent_id = v_parent_id
          AND o.submission_key = p_submission_key;

        IF v_order_id IS NOT NULL THEN
          v_replayed := TRUE;
          EXIT charge_and_create;
        END IF;
      END IF;

      -- ═════════════════════════════════════════════════════════════════════════
      -- 12. Choose what pays for this request
      --     Welcome image credits are for IMAGE requests only and are spent
      --     BEFORE candy. Video and drawing animation never look at them. The
      --     parent does not choose. The credit row is locked FOR UPDATE (after
      --     the wallet row, always in that order) so two concurrent requests
      --     cannot both see the last credit.
      -- ═════════════════════════════════════════════════════════════════════════
      IF p_type = 'image' THEN
        SELECT (wc.granted_count - wc.used_count)
        INTO v_credit_left
        FROM public.parent_welcome_credits wc
        WHERE wc.parent_id = v_parent_id
        FOR UPDATE;

        IF COALESCE(v_credit_left, 0) > 0 THEN
          v_use_credit := TRUE;
        END IF;
      END IF;

      IF v_use_credit THEN
        v_pay_source := 'welcome_image_credit';
        v_charge := 0;
      ELSE
        v_pay_source := 'candy';
        v_charge := v_candy_cost;

        IF v_wallet_balance < v_candy_cost THEN
          RAISE EXCEPTION 'INSUFFICIENT_CANDIES'
            USING HINT = 'موجودی آبنبات شما کافی نیست.';
        END IF;
      END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 13. Insert order row
    --     candy_cost comes from the catalog lookup, never from the client.
    --     ON CONFLICT is the race-condition guard: if a concurrent call for
    --     the same (parent_id, submission_key) committed first, this INSERT
    --     is skipped rather than raising, and the branch below falls back to
    --     reading what the winner created. Nothing past this point runs for
    --     the loser — no media row, no wallet debit, no ledger entry — so a
    --     losing p_order_id never gains a row anywhere, which also means
    --     step 14 cannot legally insert a media_assets row against it (the
    --     foreign key alone would refuse that).
    -- ═══════════════════════════════════════════════════════════════════════════
    -- Aliased and the RETURNING column qualified as o.id: RETURNS TABLE above
    -- declares an OUT parameter named `id`, which plpgsql exposes as a
    -- variable in scope for the rest of the function body. An unqualified
    -- `RETURNING id` is ambiguous between that variable and orders.id; only
    -- the qualified form resolves to the column.
    INSERT INTO public.orders AS o (
      id,
      parent_id,
      type,
      status,
      title,
      description,
      character_id,
      candy_cost,
      child_name,
      submission_key,
      payment_source
    ) VALUES (
      p_order_id,
      v_parent_id,
      p_type,
      'pending_review',
      NULLIF(trim(COALESCE(p_title, '')), ''),
      trim(COALESCE(p_description, '')),
      p_character_id,
      v_charge,
      NULLIF(trim(COALESCE(p_child_name, '')), ''),
      p_submission_key,
      v_pay_source
    )
    ON CONFLICT (parent_id, submission_key) WHERE submission_key IS NOT NULL DO NOTHING
    RETURNING o.id INTO v_order_id;

    IF v_order_id IS NULL THEN
      -- Lost the race: another concurrent call for the same submission_key
      -- won and already committed. Fall back to its row; create nothing.
      SELECT o.id INTO v_order_id
      FROM public.orders o
      WHERE o.parent_id = v_parent_id
        AND o.submission_key = p_submission_key;

      v_replayed := TRUE;
    ELSE
      -- ═══════════════════════════════════════════════════════════════════════════
      -- 14. Insert media_assets row (when source file exists)
      -- ═══════════════════════════════════════════════════════════════════════════
      IF v_has_file THEN
        INSERT INTO public.media_assets (
          order_id,
          type,
          file_url,
          mime_type,
          original_filename
        ) VALUES (
          v_order_id,
          'upload',
          p_file_path,
          v_trusted_mime,
          -- The name the parent's own file had. The storage path carries a
          -- sanitized ASCII form, which is unreadable for a Persian file name, so
          -- the gallery label needs this to show anything recognisable. Capped to
          -- the column's own limit rather than relying on the caller.
          NULLIF(btrim(COALESCE(left(p_original_filename, 255), '')), '')
        );
      END IF;

      -- ═══════════════════════════════════════════════════════════════════════════
      -- 15. Insert type-specific extension row
      -- ═══════════════════════════════════════════════════════════════════════════
      IF p_type = 'video' THEN
        INSERT INTO public.video_requests (
          order_id,
          script,
          style,
          duration_choice,
          characters_speak
        ) VALUES (
          v_order_id,
          trim(p_video_script),
          NULLIF(trim(COALESCE(p_video_style, '')), ''),
          p_duration_choice,
          p_characters_speak
        );
      ELSIF p_type = 'drawing_animation' THEN
        INSERT INTO public.drawing_animation_requests (
          order_id,
          upload_url,
          animation_style
        ) VALUES (
          v_order_id,
          p_file_path,
          trim(p_animation_style)
        );
      END IF;

      -- ═══════════════════════════════════════════════════════════════════════════
      -- 16. Spend exactly one source, in the SAME transaction as the order insert
      --     above. Any error from here rolls the order back too, so a failed
      --     request can never leave a credit or candy consumed.
      -- ═══════════════════════════════════════════════════════════════════════════
      IF v_use_credit THEN
        -- Guarded decrement: refuses (0 rows) rather than ever exceeding the
        -- grant, even if a future code path forgot the lock.
        UPDATE public.parent_welcome_credits wc
        SET used_count = wc.used_count + 1
        WHERE wc.parent_id = v_parent_id
          AND wc.used_count < wc.granted_count;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'WELCOME_CREDIT_EXHAUSTED'
            USING HINT = 'No welcome image credit remains.';
        END IF;

        -- Separate, immutable record: "this image used a welcome credit".
        -- Deliberately NOT a candy_transactions row - no candy moved.
        INSERT INTO public.parent_welcome_credit_usages (parent_id, order_id)
        VALUES (v_parent_id, v_order_id);
      ELSE
        -- Candy path - behaviour unchanged: deduct the catalog price from the
        -- locked wallet, then append the immutable ledger row below.
        UPDATE public.candy_wallets cw
        SET balance = balance - v_candy_cost
        WHERE cw.id = v_wallet_id;

        -- ═══════════════════════════════════════════════════════════════════════════
        -- 17. Insert immutable ledger transaction
        --     type = order_debit, idempotency_key = 'order_debit:' || v_order_id.
        --     Kept as a second defence even though submission_key is now the
        --     primary guard: this insert only ever runs once per v_order_id,
        --     since v_order_id is only ever created once (the ON CONFLICT branch
        --     above never reaches here).
        -- ═══════════════════════════════════════════════════════════════════════════
        INSERT INTO public.candy_transactions (
          wallet_id,
          amount,
          type,
          reference_type,
          reference_id,
          description,
          idempotency_key
        ) VALUES (
          v_wallet_id,
          -v_candy_cost,
          'order_debit',
          'order',
          v_order_id,
          'مصرف آبنبات برای سفارش',
          'order_debit:' || v_order_id
        );
      END IF;
    END IF;
    END;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 18. Return the order — created just now, or replayed from an earlier
  --     attempt with the same submission_key. The client cannot tell, and
  --     does not need to: it always redirects to /dashboard/orders/<id>.
  -- ═══════════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT
    o.id,
    o.type,
    o.status,
    o.candy_cost,
    v_replayed,
    o.payment_source
  FROM public.orders o
  WHERE o.id = v_order_id;
END;
$$;

COMMENT ON FUNCTION public.create_parent_request_trusted IS 'Trusted server-only parent request creation. Callable only by the backend (EXECUTE is not granted to PUBLIC). Idempotent per (parent_id, submission_key). Atomically inserts the order (and extensions) and spends exactly ONE payment source: for image requests a welcome image credit when one remains (no candy moves, no candy_transactions row), otherwise candy from the locked wallet with an immutable ledger entry. Video and drawing animation always use candy. Returns payment_source, which on a replay is the ORIGINAL order''s source. Pricing resolved exclusively from public.creation_pricing.';

CREATE FUNCTION public.create_payment_attempt_trusted(p_purchase_id uuid, p_parent_profile_id uuid, p_provider text, p_checkout_expires_at timestamp with time zone, p_idempotency_key text) RETURNS TABLE(id uuid, purchase_id uuid, provider text, status text, provider_session_id text, provider_transaction_id text, provider_payment_reference text, checkout_url text, checkout_expires_at timestamp with time zone, requested_amount integer, requested_currency text, verified_amount integer, verified_currency text, provider_verified_at timestamp with time zone, failure_code text, failure_message_safe text, attempt_number integer, idempotency_key text, created_at timestamp with time zone, updated_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_purchase_parent_id UUID;
  v_purchase_status   TEXT;
  v_price_amount      INTEGER;
  v_currency          TEXT;
  v_next_attempt      INTEGER;
  v_attempt_id        UUID;
  v_existing_id       UUID;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- 1. Input validation (trusted server inputs, but never trust blindly)
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_purchase_id IS NULL THEN
    RAISE EXCEPTION 'attempt_purchase_required'
      USING HINT = 'Purchase ID is required.';
  END IF;

  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'attempt_parent_required'
      USING HINT = 'Parent profile ID is required.';
  END IF;

  IF p_provider IS NULL OR char_length(trim(p_provider)) = 0 THEN
    RAISE EXCEPTION 'attempt_provider_required'
      USING HINT = 'Payment provider is required.';
  END IF;

  IF p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'attempt_idempotency_required'
      USING HINT = 'Idempotency key is required.';
  END IF;

  IF char_length(trim(p_idempotency_key)) > 255 THEN
    RAISE EXCEPTION 'attempt_idempotency_too_long'
      USING HINT = 'Idempotency key must not exceed 255 characters.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 2. Lock purchase row FOR UPDATE (serializes attempt creation per purchase)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT parent_id, status, price_amount, currency
    INTO v_purchase_parent_id, v_purchase_status, v_price_amount, v_currency
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt_purchase_not_found'
      USING HINT = 'Purchase record not found.';
  END IF;

  -- Ownership verification (defense in depth — server already resolved the profile)
  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'attempt_purchase_not_owner'
      USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 3. Idempotency — return the existing attempt for this (purchase, key)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_existing_id
  FROM public.payment_attempts
  WHERE purchase_id = p_purchase_id
    AND idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY
    SELECT pa.*
    FROM public.payment_attempts pa
    WHERE pa.id = v_existing_id;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 4. Purchase status check — paid and cancelled are terminal; failed and
  --    expired may be retried (a new attempt on the same business purchase).
  -- ═══════════════════════════════════════════════════════════════════════
  IF v_purchase_status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'attempt_purchase_not_retryable'
      USING HINT = 'This purchase cannot accept new payment attempts.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 5. Compute next attempt number (1-based, unique per purchase)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT COALESCE(MAX(attempt_number), 0) + 1
    INTO v_next_attempt
  FROM public.payment_attempts
  WHERE purchase_id = p_purchase_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 6. Insert attempt. Amounts/currency come from the purchase snapshot —
  --    NEVER from caller input. Status starts at 'created'.
  -- ═══════════════════════════════════════════════════════════════════════
  INSERT INTO public.payment_attempts (
    purchase_id,
    provider,
    status,
    requested_amount,
    requested_currency,
    checkout_expires_at,
    attempt_number,
    idempotency_key
  ) VALUES (
    p_purchase_id,
    trim(p_provider),
    'created',
    v_price_amount,
    v_currency,
    p_checkout_expires_at,
    v_next_attempt,
    p_idempotency_key
  )
  RETURNING id INTO v_attempt_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 7. Point the purchase at the new attempt and re-activate if retry.
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.candy_purchases
  SET active_payment_attempt_id = v_attempt_id,
      payment_provider = trim(p_provider),
      status = CASE WHEN v_purchase_status IN ('failed', 'expired') THEN 'pending' ELSE v_purchase_status END,
      expires_at = COALESCE(p_checkout_expires_at, expires_at),
      failed_at = NULL,
      cancelled_at = NULL
  WHERE id = p_purchase_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 8. Return the created attempt
  -- ═══════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT pa.*
  FROM public.payment_attempts pa
  WHERE pa.id = v_attempt_id;
END;
$$;

COMMENT ON FUNCTION public.create_payment_attempt_trusted IS 'Trusted server-only payment-attempt creation. Callable only by the backend (EXECUTE is not granted to PUBLIC). Accepts a verified parent_profile_id and an idempotency key. Snapshot amounts are copied from the candy_purchases row (price_amount/currency), never from caller input. Creates a new attempt row (status=created) with the next unique attempt_number, and points the purchase at it. Idempotent — retrying with the same (purchase_id, idempotency_key) returns the existing attempt.';

CREATE FUNCTION public.delete_homepage_media_trusted(p_admin_user_id uuid, p_slot_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_old public.homepage_media_assets%ROWTYPE;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_media_forbidden';
  END IF;

  IF p_slot_key NOT IN (
    'hero.background', 'hero.tv_video', 'sections.background',
    'build_options.card_image', 'build_options.card_video',
    'build_options.card_animation', 'safety.image'
  ) THEN
    RAISE EXCEPTION 'homepage_media_invalid_slot';
  END IF;

  SELECT * INTO v_old
  FROM public.homepage_media_assets
  WHERE public.homepage_media_assets.slot_key = p_slot_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'homepage_media_not_found';
  END IF;

  DELETE FROM public.homepage_media_assets
  WHERE public.homepage_media_assets.slot_key = p_slot_key;

  RETURN jsonb_build_object(
    'slot_key', v_old.slot_key,
    'storage_path', v_old.storage_path,
    'mime_type', v_old.mime_type,
    'byte_size', v_old.byte_size
  );
END;
$$;

COMMENT ON FUNCTION public.delete_homepage_media_trusted IS 'Trusted server-only homepage media revert. Callable only by the backend (EXECUTE is not granted to PUBLIC). Deletes the slot metadata row and returns the previous storage metadata for best-effort object cleanup.';

CREATE FUNCTION public.get_admin_referral_overview_trusted(p_actor_user_id uuid) RETURNS TABLE(is_enabled boolean, reward_basis_points integer, settings_updated_at timestamp with time zone, total_parent_profiles bigint, total_referral_relationships bigint, total_unbound_parent_profiles bigint, total_deleted_identity_relationships bigint, settings_history_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_user_id UUID;
  v_role    TEXT;
BEGIN
  v_user_id := p_actor_user_id;
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

COMMENT ON FUNCTION public.get_admin_referral_overview_trusted IS 'Admin/super_admin overview of referral program: settings, parent/relationship counts, unbound parents, deleted-identity relationships, and history entry count.';

CREATE FUNCTION public.get_admin_referral_relationships_trusted(p_actor_user_id uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0) RETURNS TABLE(relationship_id uuid, bound_at timestamp with time zone, binding_source text, referral_code_snapshot text, referred_parent_name text, referred_parent_email text, referrer_parent_name text, referrer_parent_email text, referrer_current_code text, total_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_user_id UUID;
  v_role    TEXT;
  v_search  TEXT;
BEGIN
  -- 1. Caller identity - authenticated by the backend
  v_user_id := p_actor_user_id;
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

COMMENT ON FUNCTION public.get_admin_referral_relationships_trusted IS 'Paginated, searchable admin listing of referral relationships. Admin/super_admin only. Deleted-parent fields return NULL. total_count reflects unfiltered count.';

CREATE FUNCTION public.get_parent_referral_summary_trusted(p_user_id uuid) RETURNS TABLE(referral_code text, is_enabled boolean, reward_basis_points integer, is_bound boolean, bound_at timestamp with time zone, referred_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_user_id       UUID;
  v_parent_id     UUID;
  v_settings      RECORD;
  v_relationship  RECORD;
  v_referred_cnt  BIGINT;
BEGIN
  -- 1. Caller identity - authenticated and session-checked by the backend
  v_user_id := p_user_id;
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

COMMENT ON FUNCTION public.get_parent_referral_summary_trusted IS 'Returns the authenticated parent referral summary: own code, program settings, binding state, and referred count. No other-parent identity exposed.';

CREATE FUNCTION public.get_order_status_history_admin_trusted(p_actor_user_id uuid, p_order_id uuid) RETURNS TABLE(id uuid, previous_status text, new_status text, changed_by_name text, changed_by_deleted boolean, internal_note text, parent_visible_note text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_user_id(p_actor_user_id) THEN
    RAISE EXCEPTION 'request_forbidden' USING HINT = 'Admin role required.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_order_id) THEN
    RAISE EXCEPTION 'request_not_found' USING HINT = 'Order not found.';
  END IF;

  RETURN QUERY
  SELECT h.id, h.previous_status, h.new_status,
         u.email AS changed_by_name,
         (u.id IS NULL OR u.deleted_at IS NOT NULL) AS changed_by_deleted,
         h.internal_note, h.parent_visible_note, h.created_at
  FROM public.order_status_history h
  LEFT JOIN public.users u ON u.id = h.changed_by_user_id
  WHERE h.order_id = p_order_id
  ORDER BY h.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_order_status_history_admin_trusted IS 'Admin-only history read. Returns internal notes and a safe admin display name (email). Never returns auth user IDs to the client; the API maps the result to a safe model.';

CREATE FUNCTION public.get_parent_order_status_history_trusted(p_parent_profile_id uuid, p_order_id uuid) RETURNS TABLE(previous_status text, new_status text, parent_visible_note text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = p_order_id
      AND o.parent_id = p_parent_profile_id
  ) THEN
    RAISE EXCEPTION 'request_forbidden' USING HINT = 'Order is not accessible to this account.';
  END IF;

  RETURN QUERY
  SELECT h.previous_status, h.new_status, h.parent_visible_note, h.created_at
  FROM public.order_status_history h
  WHERE h.order_id = p_order_id
  ORDER BY h.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_parent_order_status_history_trusted IS 'Parent-safe history read for the parent''s own order. Exposes status and parent_visible_note only — internal notes and admin identity are never returned.';

CREATE FUNCTION public.get_parent_orders_delivered_at_trusted(p_parent_profile_id uuid, p_order_ids uuid[]) RETURNS TABLE(order_id uuid, delivered_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT h.order_id, MIN(h.created_at) AS delivered_at
  FROM public.order_status_history h
  JOIN public.orders o ON o.id = h.order_id
  WHERE h.order_id = ANY(p_order_ids)
    AND h.new_status = 'delivered'
    AND o.parent_id = p_parent_profile_id
  GROUP BY h.order_id
$$;

COMMENT ON FUNCTION public.get_parent_orders_delivered_at_trusted IS 'Batch, parent-safe read of the earliest delivered transition per order, restricted to orders owned by the caller (current_parent_profile_id()). Returns order_id + delivered_at only — no status detail, no notes, no actor identity. An id in p_order_ids that the caller does not own is silently excluded, never raised. Lets the parent orders list compute completedAt in one call instead of one get_parent_order_status_history call per order.';

CREATE FUNCTION public.record_final_media_trusted(p_admin_user_id uuid, p_order_id uuid, p_file_path text, p_mime_type text, p_byte_size integer, p_original_filename text) RETURNS TABLE(asset_id uuid, asset_role text, delivery_status text, parent_visible boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_order_status TEXT;
  v_filename     TEXT;
  v_asset_id     UUID;
BEGIN
  -- 1. Admin role check.
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  -- 2. Order exists and its status allows final upload.
  SELECT o.status INTO v_order_status
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_order_status IS NULL THEN
    RAISE EXCEPTION 'request_not_found' USING HINT = 'Order not found.';
  END IF;

  IF v_order_status NOT IN ('pending_review', 'in_progress', 'ready') THEN
    RAISE EXCEPTION 'request_upload_not_allowed'
      USING HINT = 'Final upload is not allowed for this status.';
  END IF;

  -- 3. Path safety: relative, no traversal, exact prefix orders/<order-id>/final/.
  IF p_file_path IS NULL OR p_file_path LIKE '/%' THEN
    RAISE EXCEPTION 'request_invalid_path' USING HINT = 'Storage path must be relative.';
  END IF;
  IF p_file_path LIKE '%/../%' OR p_file_path LIKE '../%' OR p_file_path LIKE '%/..' OR p_file_path = '..' THEN
    RAISE EXCEPTION 'request_invalid_path' USING HINT = 'Path traversal is not allowed.';
  END IF;
  IF p_file_path NOT LIKE 'orders/' || p_order_id::text || '/final/%' THEN
    RAISE EXCEPTION 'request_invalid_path'
      USING HINT = 'Storage path must match orders/<order-id>/final/<filename>.';
  END IF;

  -- 4. Plain-PostgreSQL contract (V0.1.38): object existence and MIME
  --    agreement are verified by the backend against the storage provider
  --    BEFORE this call; p_mime_type is that verified value.
  IF p_mime_type IS NULL OR pg_catalog.btrim(p_mime_type) = '' THEN
    RAISE EXCEPTION 'request_file_invalid' USING HINT = 'Verified MIME type is required.';
  END IF;

  -- 5. Filename length + byte size sanity.
  v_filename := trim(COALESCE(p_original_filename, ''));
  IF v_filename = '' THEN v_filename := 'final'; END IF;
  IF char_length(v_filename) > 255 THEN
    v_filename := left(v_filename, 255);
  END IF;
  IF p_byte_size IS NULL OR p_byte_size < 0 THEN
    RAISE EXCEPTION 'request_file_invalid' USING HINT = 'Invalid byte size.';
  END IF;

  -- 6. Insert metadata. type=generated, asset_role=final, delivery_status=uploaded,
  --    parent_visible=false until explicit approval.
  INSERT INTO public.media_assets (
    order_id, type, asset_role, delivery_status, file_url, mime_type,
    uploaded_by_user_id, original_filename, byte_size, parent_visible, moderation_status
  ) VALUES (
    p_order_id, 'generated', 'final', 'uploaded', p_file_path, p_mime_type,
    p_admin_user_id, v_filename, p_byte_size, FALSE, 'pending'
  )
  RETURNING id INTO v_asset_id;

  -- 7. Controlled result.
  RETURN QUERY
  SELECT v_asset_id, 'final'::TEXT, 'uploaded'::TEXT, FALSE;
END;
$$;

COMMENT ON FUNCTION public.record_final_media_trusted IS 'Trusted service-role-only final-media metadata insert. Re-verifies admin role, order status allows upload, path safety/prefix, and that the storage object exists with a matching MIME. Inserts an uploaded, non-parent-visible final asset. On failure the API route removes the uploaded object.';

CREATE FUNCTION public.record_homepage_media_replacement_trusted(p_admin_user_id uuid, p_primary_slot text, p_media_type text, p_storage_path text, p_mime_type text, p_byte_size bigint, p_width integer, p_height integer, p_duration_seconds numeric, p_hero_tv_rect jsonb DEFAULT NULL::jsonb, p_expected_layout_revision integer DEFAULT NULL::integer, p_apply_to_sections boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_current_layout_revision INTEGER;
  v_new_layout_revision INTEGER;
  v_rx FLOAT; v_ry FLOAT; v_rw FLOAT; v_rh FLOAT;
  v_primary public.homepage_media_assets%ROWTYPE;
  v_sections public.homepage_media_assets%ROWTYPE;
BEGIN
  -- 1. Admin role check (defense in depth; callable only by the backend anyway).
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_media_forbidden';
  END IF;

  -- 2. Slot allowlist (mirrors lib/homepage/media-slots.ts + table CHECK).
  IF p_primary_slot NOT IN (
    'hero.background', 'hero.tv_video', 'sections.background',
    'build_options.card_image', 'build_options.card_video',
    'build_options.card_animation', 'safety.image'
  ) THEN
    RAISE EXCEPTION 'homepage_media_invalid_slot';
  END IF;

  -- 3. Slot/media-type compatibility.
  IF p_primary_slot IN ('hero.background', 'sections.background',
                        'build_options.card_image', 'safety.image')
     AND p_media_type <> 'image' THEN
    RAISE EXCEPTION 'homepage_media_type_mismatch';
  END IF;
  IF p_primary_slot IN ('hero.tv_video', 'build_options.card_video',
                        'build_options.card_animation')
     AND p_media_type <> 'video' THEN
    RAISE EXCEPTION 'homepage_media_type_mismatch';
  END IF;

  -- 4. Storage path safety (key only: no scheme, no protocol-relative, no traversal).
  IF p_storage_path IS NULL OR char_length(trim(p_storage_path)) = 0
     OR p_storage_path ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
     OR p_storage_path LIKE '//%'
     OR p_storage_path LIKE '%..%' THEN
    RAISE EXCEPTION 'homepage_media_invalid_path';
  END IF;

  -- 5. MIME allowlist matched to the declared type.
  IF p_media_type = 'image'
     AND p_mime_type NOT IN ('image/png', 'image/jpeg', 'image/webp') THEN
    RAISE EXCEPTION 'homepage_media_invalid_mime';
  END IF;
  IF p_media_type = 'video'
     AND p_mime_type NOT IN ('video/mp4', 'video/webm') THEN
    RAISE EXCEPTION 'homepage_media_invalid_mime';
  END IF;

  -- 6. Byte size sanity (bucket ceiling; stricter per-slot caps live in the API).
  IF p_byte_size IS NULL OR p_byte_size <= 0 OR p_byte_size > 52428800 THEN
    RAISE EXCEPTION 'homepage_media_invalid_size';
  END IF;

  -- 7. Geometry block. hero.background replacement REQUIRES a valid rect:
  --    new artwork must never silently inherit old TV placement.
  IF p_primary_slot = 'hero.background' THEN
    IF p_hero_tv_rect IS NULL OR jsonb_typeof(p_hero_tv_rect) <> 'object' THEN
      RAISE EXCEPTION 'homepage_media_geometry_required';
    END IF;
    BEGIN
      v_rx := (p_hero_tv_rect->>'x')::float;
      v_ry := (p_hero_tv_rect->>'y')::float;
      v_rw := (p_hero_tv_rect->>'width')::float;
      v_rh := (p_hero_tv_rect->>'height')::float;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'homepage_media_layout_invalid';
    END;
    IF v_rx IS NULL OR v_ry IS NULL OR v_rw IS NULL OR v_rh IS NULL
       OR v_rx != v_rx OR v_ry != v_ry OR v_rw != v_rw OR v_rh != v_rh
       OR v_rx < 0 OR v_rx > 1 OR v_ry < 0 OR v_ry > 1
       OR v_rw <= 0 OR v_rh <= 0
       OR v_rx + v_rw > 1 OR v_ry + v_rh > 1 THEN
      RAISE EXCEPTION 'homepage_media_layout_invalid';
    END IF;
    IF p_expected_layout_revision IS NULL THEN
      RAISE EXCEPTION 'homepage_media_layout_conflict';
    END IF;
  ELSIF p_hero_tv_rect IS NOT NULL THEN
    -- Geometry is only ever accepted alongside a hero.background replacement.
    RAISE EXCEPTION 'homepage_media_invalid';
  END IF;

  IF p_apply_to_sections AND p_primary_slot <> 'hero.background' THEN
    RAISE EXCEPTION 'homepage_media_invalid';
  END IF;

  -- 8. Lock the layout row FIRST (fixed order: layout, then media rows),
  --    so concurrent replacements serialize identically and cannot deadlock.
  IF p_primary_slot = 'hero.background' THEN
    SELECT public.homepage_hero_layout.revision
    INTO v_current_layout_revision
    FROM public.homepage_hero_layout
    WHERE public.homepage_hero_layout.singleton_key = 'hero'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'homepage_media_layout_missing';
    END IF;
    IF v_current_layout_revision <> p_expected_layout_revision THEN
      RAISE EXCEPTION 'homepage_media_layout_conflict';
    END IF;
    v_new_layout_revision := v_current_layout_revision + 1;
  END IF;

  -- 9. Upsert the primary media row.
  INSERT INTO public.homepage_media_assets AS m
    (slot_key, media_type, storage_path, mime_type, byte_size,
     width, height, duration_seconds, updated_by_user_id)
  VALUES
    (p_primary_slot, p_media_type, p_storage_path, p_mime_type, p_byte_size,
     p_width, p_height, p_duration_seconds, p_admin_user_id)
  ON CONFLICT (slot_key) DO UPDATE SET
    media_type = EXCLUDED.media_type,
    storage_path = EXCLUDED.storage_path,
    mime_type = EXCLUDED.mime_type,
    byte_size = EXCLUDED.byte_size,
    width = EXCLUDED.width,
    height = EXCLUDED.height,
    duration_seconds = EXCLUDED.duration_seconds,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = now()
  RETURNING * INTO v_primary;

  -- 10. Shared-background commit: SAME transaction, SAME object.
  IF p_apply_to_sections THEN
    INSERT INTO public.homepage_media_assets AS m
      (slot_key, media_type, storage_path, mime_type, byte_size,
       width, height, duration_seconds, updated_by_user_id)
    VALUES
      ('sections.background', p_media_type, p_storage_path, p_mime_type, p_byte_size,
       p_width, p_height, p_duration_seconds, p_admin_user_id)
    ON CONFLICT (slot_key) DO UPDATE SET
      media_type = EXCLUDED.media_type,
      storage_path = EXCLUDED.storage_path,
      mime_type = EXCLUDED.mime_type,
      byte_size = EXCLUDED.byte_size,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      duration_seconds = EXCLUDED.duration_seconds,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING * INTO v_sections;
  END IF;

  -- 11. Hero layout update in the SAME transaction; revision bumped exactly once.
  IF p_primary_slot = 'hero.background' THEN
    UPDATE public.homepage_hero_layout
    SET tv_rect = jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
        revision = v_new_layout_revision,
        updated_by_user_id = p_admin_user_id,
        updated_at = now()
    WHERE public.homepage_hero_layout.singleton_key = 'hero';
  END IF;

  -- 12. Safe snapshots for the API (storage paths stay server-side; the
  --     serializer strips them before anything reaches the browser).
  RETURN jsonb_build_object(
    'media', jsonb_build_object(
      'slot_key', v_primary.slot_key,
      'media_type', v_primary.media_type,
      'storage_path', v_primary.storage_path,
      'mime_type', v_primary.mime_type,
      'byte_size', v_primary.byte_size,
      'width', v_primary.width,
      'height', v_primary.height,
      'duration_seconds', v_primary.duration_seconds,
      'updated_at', v_primary.updated_at
    ),
    'sections', CASE WHEN p_apply_to_sections THEN jsonb_build_object(
      'slot_key', v_sections.slot_key,
      'storage_path', v_sections.storage_path,
      'mime_type', v_sections.mime_type,
      'byte_size', v_sections.byte_size,
      'width', v_sections.width,
      'height', v_sections.height,
      'updated_at', v_sections.updated_at
    ) ELSE NULL END,
    'layout', CASE WHEN p_primary_slot = 'hero.background' THEN jsonb_build_object(
      'tv_rect', jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
      'revision', v_new_layout_revision
    ) ELSE NULL END
  );
END;
$$;

COMMENT ON FUNCTION public.record_homepage_media_replacement_trusted IS 'Trusted server-only homepage media replacement. Callable only by the backend (EXECUTE is not granted to PUBLIC). Commits primary media upsert + optional shared sections upsert + optional hero layout update in ONE transaction. Any failure rolls everything back.';

CREATE FUNCTION public.record_payment_attempt_session_trusted(p_attempt_id uuid, p_provider_session_id text, p_checkout_url text, p_checkout_expires_at timestamp with time zone) RETURNS TABLE(id uuid, purchase_id uuid, provider text, status text, provider_session_id text, provider_transaction_id text, provider_payment_reference text, checkout_url text, checkout_expires_at timestamp with time zone, requested_amount integer, requested_currency text, verified_amount integer, verified_currency text, provider_verified_at timestamp with time zone, failure_code text, failure_message_safe text, attempt_number integer, idempotency_key text, created_at timestamp with time zone, updated_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_attempt_status      TEXT;
  v_attempt_provider    TEXT;
  v_attempt_purchase_id UUID;
  v_attempt_session     TEXT;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- 1. Input validation
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'attempt_id_required'
      USING HINT = 'Attempt ID is required.';
  END IF;

  IF p_provider_session_id IS NULL OR char_length(trim(p_provider_session_id)) = 0 THEN
    RAISE EXCEPTION 'attempt_session_id_required'
      USING HINT = 'Provider session ID is required.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 2. Lock the attempt row FOR UPDATE
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT status, provider, purchase_id, provider_session_id
    INTO v_attempt_status, v_attempt_provider, v_attempt_purchase_id, v_attempt_session
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt_not_found'
      USING HINT = 'Payment attempt not found.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 3. Only a freshly created attempt may receive its first session.
  -- ═══════════════════════════════════════════════════════════════════════
  IF v_attempt_status IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'attempt_not_created'
      USING HINT = 'Only newly created attempts can record a provider session.';
  END IF;

  -- Reject session ID reuse on the same attempt
  IF v_attempt_session IS NOT NULL THEN
    RAISE EXCEPTION 'attempt_session_already_set'
      USING HINT = 'This attempt already has a provider session.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 4. Record the session and move the attempt to awaiting_payment.
  --    Unique (provider, provider_session_id) index rejects cross-attempt reuse.
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.payment_attempts
  SET provider_session_id = trim(p_provider_session_id),
      checkout_url = p_checkout_url,
      checkout_expires_at = COALESCE(p_checkout_expires_at, checkout_expires_at),
      status = 'awaiting_payment'
  WHERE id = p_attempt_id;

  -- Mirror expiry onto the purchase
  IF p_checkout_expires_at IS NOT NULL THEN
    UPDATE public.candy_purchases
    SET expires_at = p_checkout_expires_at
    WHERE id = v_attempt_purchase_id;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 5. Return the updated attempt
  -- ═══════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT pa.*
  FROM public.payment_attempts pa
  WHERE pa.id = p_attempt_id;
END;
$$;

COMMENT ON FUNCTION public.record_payment_attempt_session_trusted IS 'Trusted server-only session recording. Callable only by the backend (EXECUTE is not granted to PUBLIC). Stores the provider checkout/session reference on a freshly created attempt and moves it to awaiting_payment. Provider session IDs are unique per provider via a partial unique index; session reuse is rejected.';

CREATE FUNCTION public.supersede_final_media_trusted(p_admin_user_id uuid, p_asset_id uuid, p_order_id uuid) RETURNS TABLE(asset_id uuid, asset_role text, delivery_status text, parent_visible boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_role     TEXT;
  v_delivery TEXT;
  v_order_id UUID;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  SELECT ma.asset_role, ma.delivery_status, ma.order_id
    INTO v_role, v_delivery, v_order_id
  FROM public.media_assets ma
  WHERE ma.id = p_asset_id
  FOR UPDATE;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset not found.';
  END IF;
  IF v_order_id IS DISTINCT FROM p_order_id THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset does not belong to this order.';
  END IF;
  IF v_role <> 'final' THEN
    RAISE EXCEPTION 'request_asset_not_final' USING HINT = 'Only final assets can be superseded.';
  END IF;
  IF v_delivery NOT IN ('uploaded', 'approved') THEN
    RAISE EXCEPTION 'request_asset_already_superseded'
      USING HINT = 'This asset is already superseded.';
  END IF;

  UPDATE public.media_assets
  SET delivery_status = 'superseded',
      parent_visible  = FALSE,
      superseded_at   = now()
  WHERE id = p_asset_id;

  RETURN QUERY
  SELECT p_asset_id, v_role, 'superseded'::TEXT, FALSE;
END;
$$;

COMMENT ON FUNCTION public.supersede_final_media_trusted IS 'Trusted service-role-only supersede: hides an uploaded/approved final asset, keeps history, and stamps superseded_at. No permanent deletion.';

CREATE FUNCTION public.update_admin_referral_program_settings_trusted(p_actor_user_id uuid, p_is_enabled boolean, p_reward_basis_points integer, p_expected_updated_at timestamp with time zone) RETURNS TABLE(status text, is_enabled boolean, reward_basis_points integer, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_user_id      UUID;
  v_role         TEXT;
  v_current      RECORD;
  v_settings_id  SMALLINT;
  v_new_updated_at TIMESTAMPTZ;
  v_actual_changed BOOLEAN;
BEGIN
  -- 1. Caller identity - authenticated by the backend
  v_user_id := p_actor_user_id;
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

COMMENT ON FUNCTION public.update_admin_referral_program_settings_trusted IS 'Admin/super_admin settings update with optimistic concurrency. Locks singleton row FOR UPDATE. Validates rate (0-10000). Returns conflict if p_expected_updated_at does not match current. Returns unchanged if no values differ (no history written). On real change, updates row and inserts immutable history in one transaction.';

CREATE FUNCTION public.update_coupon_trusted(p_admin_user_id uuid, p_coupon_id uuid, p_expected_updated_at timestamp with time zone, p_code text, p_name text, p_description text, p_discount_type text, p_discount_value integer, p_is_active boolean, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_global_usage_limit integer, p_per_parent_usage_limit integer, p_minimum_purchase_amount integer, p_maximum_discount_amount integer, p_package_ids uuid[]) RETURNS TABLE(coupon_id uuid, code text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
#variable_conflict use_column
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
$_$;

COMMENT ON FUNCTION public.update_coupon_trusted IS 'Trusted server-only admin coupon update. Callable only by the backend (EXECUTE is not granted to PUBLIC). Verifies the passed admin user id, locks the coupon FOR UPDATE, enforces optimistic concurrency (coupon_admin_conflict on mismatch), validates all fields, rejects immutable discount changes after usage, rejects usage-limit reductions below current usage, and replaces package rules atomically. Raises coupon_admin_* codes on failure.';

CREATE FUNCTION public.update_homepage_content_trusted(p_admin_user_id uuid, p_content_json jsonb, p_expected_revision integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_current_revision INTEGER;
  v_new_revision INTEGER;
BEGIN
  -- 1. Admin role check (defense in depth; callable only by the backend anyway).
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_admin_forbidden';
  END IF;

  -- 2. Lock the singleton row to serialize concurrent updates.
  SELECT public.homepage_content.revision
  INTO v_current_revision
  FROM public.homepage_content
  WHERE public.homepage_content.singleton_key = 'homepage'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'homepage_admin_not_found';
  END IF;

  -- 3. Optimistic concurrency guard.
  IF v_current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'homepage_admin_conflict';
  END IF;

  -- 4. Structural safety net (deep validation lives in the application).
  IF jsonb_typeof(p_content_json) <> 'object' THEN
    RAISE EXCEPTION 'homepage_admin_invalid';
  END IF;

  IF NOT (p_content_json ? 'hero') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'buildOptions') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'characters') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'safety') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'pricing') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'testimonials') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'faqTeaser') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'finalCta') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;

  -- 5. Bump revision and update atomically.
  v_new_revision := v_current_revision + 1;

  UPDATE public.homepage_content
  SET content_json = p_content_json,
      revision = v_new_revision,
      updated_by_user_id = p_admin_user_id,
      updated_at = now()
  WHERE public.homepage_content.singleton_key = 'homepage';

  RETURN jsonb_build_object(
    'content_json', p_content_json,
    'revision', v_new_revision,
    'updated_at', now(),
    'updated_by_user_id', p_admin_user_id
  );
END;
$$;

COMMENT ON FUNCTION public.update_homepage_content_trusted IS 'Trusted server-only homepage content update. Callable only by the backend (EXECUTE is not granted to PUBLIC). Re-verifies admin role, enforces optimistic concurrency via revision, returns the new row snapshot.';

CREATE FUNCTION public.update_homepage_hero_layout_trusted(p_admin_user_id uuid, p_tv_rect jsonb, p_expected_revision integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_current_revision INTEGER;
  v_new_revision INTEGER;
  v_rx FLOAT; v_ry FLOAT; v_rw FLOAT; v_rh FLOAT;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_layout_forbidden';
  END IF;

  IF p_tv_rect IS NULL OR jsonb_typeof(p_tv_rect) <> 'object' THEN
    RAISE EXCEPTION 'homepage_layout_invalid';
  END IF;
  BEGIN
    v_rx := (p_tv_rect->>'x')::float;
    v_ry := (p_tv_rect->>'y')::float;
    v_rw := (p_tv_rect->>'width')::float;
    v_rh := (p_tv_rect->>'height')::float;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'homepage_layout_invalid';
  END;
  IF v_rx IS NULL OR v_ry IS NULL OR v_rw IS NULL OR v_rh IS NULL
     OR v_rx != v_rx OR v_ry != v_ry OR v_rw != v_rw OR v_rh != v_rh
     OR v_rx < 0 OR v_rx > 1 OR v_ry < 0 OR v_ry > 1
     OR v_rw <= 0 OR v_rh <= 0
     OR v_rx + v_rw > 1 OR v_ry + v_rh > 1 THEN
    RAISE EXCEPTION 'homepage_layout_invalid';
  END IF;

  SELECT public.homepage_hero_layout.revision
  INTO v_current_revision
  FROM public.homepage_hero_layout
  WHERE public.homepage_hero_layout.singleton_key = 'hero'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'homepage_layout_not_found';
  END IF;
  IF v_current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'homepage_layout_conflict';
  END IF;

  v_new_revision := v_current_revision + 1;

  UPDATE public.homepage_hero_layout
  SET tv_rect = jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
      revision = v_new_revision,
      updated_by_user_id = p_admin_user_id,
      updated_at = now()
  WHERE public.homepage_hero_layout.singleton_key = 'hero';

  RETURN jsonb_build_object(
    'tv_rect', jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
    'revision', v_new_revision,
    'updated_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.update_homepage_hero_layout_trusted IS 'Trusted server-only hero TV rect calibration edit. Callable only by the backend (EXECUTE is not granted to PUBLIC). Revision-checked; revision bumped exactly once.';

CREATE FUNCTION public.update_order_status_trusted(p_order_id uuid, p_admin_user_id uuid, p_new_status text, p_expected_updated_at timestamp with time zone, p_internal_note text, p_parent_visible_note text) RETURNS TABLE(order_id uuid, previous_status text, new_status text, updated_at timestamp with time zone, history_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_previous_status TEXT;
  v_current_updated_at TIMESTAMPTZ;
  v_internal_note TEXT;
  v_parent_note TEXT;
  v_history_id UUID;
BEGIN
  -- 1. Admin role check (defense in depth; callable only by the backend anyway).
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  -- 2. Notes: trim whitespace; empty becomes NULL; enforce 2000 char max.
  v_internal_note := trim(COALESCE(p_internal_note, ''));
  IF v_internal_note = '' THEN v_internal_note := NULL; END IF;
  IF v_internal_note IS NOT NULL AND char_length(v_internal_note) > 2000 THEN
    RAISE EXCEPTION 'request_note_too_long' USING HINT = 'Internal note must not exceed 2000 characters.';
  END IF;

  v_parent_note := trim(COALESCE(p_parent_visible_note, ''));
  IF v_parent_note = '' THEN v_parent_note := NULL; END IF;
  IF v_parent_note IS NOT NULL AND char_length(v_parent_note) > 2000 THEN
    RAISE EXCEPTION 'request_note_too_long' USING HINT = 'Parent-visible note must not exceed 2000 characters.';
  END IF;

  -- 3. Lock the order and load its current state.
  SELECT o.status, o.updated_at
    INTO v_previous_status, v_current_updated_at
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_previous_status IS NULL THEN
    RAISE EXCEPTION 'request_not_found' USING HINT = 'Order not found.';
  END IF;

  -- 4. Optimistic concurrency: the caller must hold the latest updated_at.
  IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'request_status_conflict'
      USING HINT = 'The order was changed by another admin. Reload and retry.';
  END IF;

  -- 5. Target status must be a known order status.
  IF p_new_status NOT IN ('draft','pending_payment','pending_review','in_progress','ready','delivered','rejected','cancelled') THEN
    RAISE EXCEPTION 'request_invalid_status' USING HINT = 'Unknown target status.';
  END IF;

  -- 6. No-op guard.
  IF p_new_status = v_previous_status THEN
    RAISE EXCEPTION 'request_status_unchanged' USING HINT = 'Status is already the target status.';
  END IF;

  -- 7. Transition validity. Mirrors lib/admin/requests/workflow.ts.
  --    Operational workflow: pending_review → in_progress → ready → delivered;
  --    rejection/cancellation from pending_review or in_progress. Terminals never reopen.
  IF NOT (
    (v_previous_status = 'pending_review' AND p_new_status IN ('in_progress','rejected','cancelled'))
    OR (v_previous_status = 'in_progress' AND p_new_status IN ('ready','rejected','cancelled'))
    OR (v_previous_status = 'ready' AND p_new_status = 'delivered')
  ) THEN
    RAISE EXCEPTION 'request_transition_invalid' USING HINT = 'Transition is not allowed for this status.';
  END IF;

  -- 8. Rejection requires a reason (internal or parent-visible).
  IF p_new_status = 'rejected' AND v_internal_note IS NULL AND v_parent_note IS NULL THEN
    RAISE EXCEPTION 'request_rejection_reason_required'
      USING HINT = 'Provide an internal or parent-visible rejection reason.';
  END IF;

  -- 9. Ready requires at least one approved, parent-visible final asset.
  IF p_new_status = 'ready' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.media_assets ma
      WHERE ma.order_id = p_order_id
        AND ma.asset_role = 'final'
        AND ma.delivery_status = 'approved'
        AND ma.parent_visible = TRUE
    ) THEN
      RAISE EXCEPTION 'request_final_media_required'
        USING HINT = 'At least one approved final asset is required before ready.';
    END IF;
  END IF;

  -- 10. Update status + updated_at (orders has no updated_at trigger).
  UPDATE public.orders o
  SET status = p_new_status,
      updated_at = now()
  WHERE o.id = p_order_id;

  -- 11. Append history atomically.
  INSERT INTO public.order_status_history (
    order_id, previous_status, new_status, changed_by_user_id,
    internal_note, parent_visible_note
  ) VALUES (
    p_order_id, v_previous_status, p_new_status, p_admin_user_id,
    v_internal_note, v_parent_note
  )
  RETURNING id INTO v_history_id;

  -- 12. Controlled result.
  RETURN QUERY
  SELECT o.id, v_previous_status, o.status, o.updated_at, v_history_id
  FROM public.orders o
  WHERE o.id = p_order_id;
END;
$$;

COMMENT ON FUNCTION public.update_order_status_trusted IS 'Trusted service-role-only status transition. Locks the order FOR UPDATE, verifies expectedUpdatedAt (optimistic concurrency), validates the transition in-database, requires approved final media for ready and a reason for rejected, then updates the order and appends order_status_history atomically. No financial mutation.';

CREATE FUNCTION public.validate_coupon_for_purchase_trusted(p_parent_profile_id uuid, p_purchase_id uuid, p_coupon_code text) RETURNS TABLE(coupon_id uuid, normalized_code text, discount_type text, original_price_amount integer, discount_amount integer, final_price_amount integer, currency text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_code           TEXT;
  v_purchase_parent_id UUID;
  v_purchase_status    TEXT;
  v_original_price     INTEGER;
  v_currency           TEXT;
  v_package_id         UUID;
  v_active_attempt_id  UUID;
  v_coupon_id          UUID;
  v_discount_type      TEXT;
  v_discount_value     INTEGER;
  v_is_active          BOOLEAN;
  v_starts_at          TIMESTAMPTZ;
  v_expires_at         TIMESTAMPTZ;
  v_global_limit       INTEGER;
  v_parent_limit       INTEGER;
  v_minimum_amount     INTEGER;
  v_maximum_discount   INTEGER;
  v_used_global        INTEGER;
  v_used_parent        INTEGER;
  v_rule_count         INTEGER;
  v_discount           INTEGER;
  v_final              INTEGER;
  v_existing_redemption UUID;
BEGIN
  -- 1. Input validation
  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'coupon_parent_required' USING HINT = 'Parent profile ID is required.';
  END IF;
  IF p_purchase_id IS NULL THEN
    RAISE EXCEPTION 'coupon_purchase_required' USING HINT = 'Purchase ID is required.';
  END IF;

  -- 2. Normalize the code (uppercase + trim), validate charset/length.
  v_code := upper(trim(p_coupon_code));
  IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RAISE EXCEPTION 'coupon_code_invalid' USING HINT = 'The coupon code format is invalid.';
  END IF;

  -- 3. Load purchase (no lock — validation is advisory and read-only).
  SELECT parent_id, status, original_price_amount, currency, package_id, active_payment_attempt_id
    INTO v_purchase_parent_id, v_purchase_status, v_original_price, v_currency,
         v_package_id, v_active_attempt_id
  FROM public.candy_purchases
  WHERE id = p_purchase_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_purchase_not_found' USING HINT = 'Purchase record not found.';
  END IF;

  -- 4. Ownership
  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'coupon_purchase_not_owner' USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- 5. Status pending
  IF v_purchase_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'coupon_purchase_not_pending' USING HINT = 'Only pending purchases accept a coupon.';
  END IF;

  -- 6. No payment attempt yet — a provider session must not carry a stale price.
  IF v_active_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'coupon_purchase_has_payment_attempt'
      USING HINT = 'A payment attempt already exists for this purchase.';
  END IF;

  -- 7. No coupon already applied
  SELECT id INTO v_existing_redemption
  FROM public.coupon_redemptions
  WHERE purchase_id = p_purchase_id AND status IN ('reserved', 'redeemed');

  IF v_existing_redemption IS NOT NULL THEN
    RAISE EXCEPTION 'coupon_already_applied' USING HINT = 'A coupon is already applied to this purchase.';
  END IF;

  -- 8. Load coupon by normalized code
  SELECT id, discount_type, discount_value, is_active, starts_at, expires_at,
         global_usage_limit, per_parent_usage_limit, minimum_purchase_amount,
         maximum_discount_amount
    INTO v_coupon_id, v_discount_type, v_discount_value, v_is_active, v_starts_at,
         v_expires_at, v_global_limit, v_parent_limit, v_minimum_amount, v_maximum_discount
  FROM public.coupons
  WHERE code = v_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_not_found' USING HINT = 'No such coupon code.';
  END IF;

  -- 9. Active + date window
  IF NOT v_is_active THEN
    RAISE EXCEPTION 'coupon_inactive' USING HINT = 'The coupon is not active.';
  END IF;
  IF v_starts_at IS NOT NULL AND now() < v_starts_at THEN
    RAISE EXCEPTION 'coupon_not_started' USING HINT = 'The coupon has not started yet.';
  END IF;
  IF v_expires_at IS NOT NULL AND now() > v_expires_at THEN
    RAISE EXCEPTION 'coupon_expired' USING HINT = 'The coupon has expired.';
  END IF;

  -- 10. Usage limits (reserved + redeemed count toward limits; cancelled does not)
  SELECT count(*) INTO v_used_global
  FROM public.coupon_redemptions
  WHERE coupon_id = v_coupon_id AND status IN ('reserved', 'redeemed');

  IF v_global_limit IS NOT NULL AND v_used_global >= v_global_limit THEN
    RAISE EXCEPTION 'coupon_usage_limit_reached' USING HINT = 'The global usage limit is reached.';
  END IF;

  SELECT count(*) INTO v_used_parent
  FROM public.coupon_redemptions
  WHERE coupon_id = v_coupon_id
    AND parent_profile_id = p_parent_profile_id
    AND status IN ('reserved', 'redeemed');

  IF v_parent_limit IS NOT NULL AND v_used_parent >= v_parent_limit THEN
    RAISE EXCEPTION 'coupon_parent_limit_reached' USING HINT = 'The per-parent usage limit is reached.';
  END IF;

  -- 11. Package eligibility (zero rules = all packages; rules restrict)
  SELECT count(*) INTO v_rule_count
  FROM public.coupon_package_rules
  WHERE coupon_id = v_coupon_id;

  IF v_rule_count > 0 THEN
    PERFORM 1
    FROM public.coupon_package_rules
    WHERE coupon_id = v_coupon_id AND package_id = v_package_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'coupon_package_not_eligible' USING HINT = 'This coupon does not apply to the selected package.';
    END IF;
  END IF;

  -- 12. Minimum purchase amount (checked BEFORE discount)
  IF v_minimum_amount IS NOT NULL AND v_original_price < v_minimum_amount THEN
    RAISE EXCEPTION 'coupon_minimum_not_met' USING HINT = 'The minimum purchase amount is not met.';
  END IF;

  -- 13. Calculate discount (integer-only, floor for percentage).
  v_discount := public.calculate_coupon_discount(
    v_discount_type, v_discount_value, v_original_price, v_maximum_discount
  );

  IF v_discount <= 0 THEN
    RAISE EXCEPTION 'coupon_zero_discount'
      USING HINT = 'This coupon produces no discount for this purchase amount.';
  END IF;

  v_final := v_original_price - v_discount;

  RETURN QUERY
  SELECT v_coupon_id, v_code, v_discount_type, v_original_price, v_discount, v_final, v_currency;
END;
$_$;

COMMENT ON FUNCTION public.validate_coupon_for_purchase_trusted IS 'Trusted server-only, READ-ONLY coupon validation for a pending purchase. Callable only by the backend (EXECUTE is not granted to PUBLIC). Normalizes the code, verifies purchase ownership/pending/no-payment-attempt/no-existing-coupon, validates the coupon (active, dates, limits, package, minimum), and returns the computed discount. Creates NOTHING, updates nothing.';

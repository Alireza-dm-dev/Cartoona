-- Cartoona plain-PostgreSQL (V0.1.51) - candy purchases and payments
--
-- From V0.1.51 the candy WALLET has one authoritative database: this one.
-- Requests debit it (V0.1.50); purchases now create, price, discount and
-- credit it here too. Every money movement is one trusted function = one
-- transaction. The app role gets EXECUTE on exactly the functions below and
-- SELECT where a read needs it; it still cannot INSERT/UPDATE/DELETE
-- candy_purchases, payment_attempts, payment_webhook_events, coupon_redemptions,
-- coupons, coupon_package_rules, candy_wallets or candy_transactions.
--
-- Purchase state machine (unchanged statuses, see docs/ROUTE_CUTOVER.md V0.1.51):
--
--   pending  -> paid        confirm_payment_attempt_trusted (provider-verified)
--   pending  -> failed      fail_payment_attempt_trusted     (provider says failed)
--   failed   -> pending     create_payment_attempt_trusted   (a new attempt)
--   expired  -> pending     create_payment_attempt_trusted   (no expiry job exists yet)
--   failed   -> paid        confirm_payment_attempt_trusted  (money WAS taken: credited)
--   paid, cancelled         terminal (no code path sets cancelled today)
--
-- New functions:
--   create_candy_purchase_trusted      pending purchase from the ACTIVE package snapshot
--   confirm_payment_attempt_trusted    a verified provider "paid" event: event dedupe,
--                                      amount/currency check, attempt verified,
--                                      purchase paid, wallet credit + ledger,
--                                      coupon reserved -> redeemed - atomically
--   fail_payment_attempt_trusted       a verified provider "failed" event
--
-- Replaced (bug fixes found in the V0.1.51 audit; both bodies were otherwise
-- kept verbatim and the Supabase originals are NOT changed - nothing calls them):
--   create_payment_attempt_trusted     requested the PRE-coupon price_amount; a
--                                      provider would have charged the full price
--                                      for a discounted purchase. Now
--                                      final_price_amount, and a zero final price
--                                      is refused (nothing to charge).
--   apply_coupon_to_purchase_trusted   counted usage without locking the coupon,
--                                      so concurrent applications to DIFFERENT
--                                      purchases could exceed global/per-parent
--                                      limits. The coupon row is now locked
--                                      FOR UPDATE before counting.
--
--   validate_coupon_for_purchase_trusted, record_payment_attempt_session_trusted
--                                      and the two above: `#variable_conflict use_column`
--                                      (42702 ambiguous-column defect, see below).
--
-- Not granted (and never called by the app): complete_candy_purchase_trusted,
-- the development "simulated completion" that trusted a parent-supplied
-- reference. It stays in the schema for parity with Supabase only.

-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.create_candy_purchase_trusted(p_parent_profile_id uuid, p_package_id uuid)
    RETURNS TABLE(id uuid, candy_amount integer, price_amount integer, discount_amount integer, final_price_amount integer, currency text, status text, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_candy   integer;
  v_price   integer;
  v_cur     text;
  v_id      uuid;
BEGIN
  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'purchase_parent_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.parent_profiles pp JOIN public.users u ON u.id = pp.user_id
    WHERE pp.id = p_parent_profile_id AND u.role = 'parent' AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'purchase_parent_required';
  END IF;

  -- Price, currency and candy amount come ONLY from the active catalog row.
  SELECT cp.candy_amount, cp.price_amount, cp.currency
    INTO v_candy, v_price, v_cur
  FROM public.candy_packages cp
  WHERE cp.id = p_package_id AND cp.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_package_unavailable';
  END IF;

  INSERT INTO public.candy_purchases AS p (
    parent_id, package_id, candy_amount, price_amount, original_price_amount,
    discount_amount, final_price_amount, currency, status
  ) VALUES (
    p_parent_profile_id, p_package_id, v_candy, v_price, v_price, 0, v_price, v_cur, 'pending'
  )
  RETURNING p.id INTO v_id;

  RETURN QUERY
  SELECT p.id, p.candy_amount, p.price_amount, p.discount_amount, p.final_price_amount, p.currency, p.status, p.created_at
  FROM public.candy_purchases p WHERE p.id = v_id;
END;
$$;

COMMENT ON FUNCTION public.create_candy_purchase_trusted IS 'Trusted pending-purchase creation (V0.1.51). The caller supplies only the verified parent profile and a package id; candy amount, price and currency are snapshotted from the ACTIVE candy_packages row. No wallet or ledger effect.';

-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_payment_attempt_trusted(p_purchase_id uuid, p_parent_profile_id uuid, p_provider text, p_checkout_expires_at timestamp with time zone, p_idempotency_key text) RETURNS TABLE(id uuid, purchase_id uuid, provider text, status text, provider_session_id text, provider_transaction_id text, provider_payment_reference text, checkout_url text, checkout_expires_at timestamp with time zone, requested_amount integer, requested_currency text, verified_amount integer, verified_currency text, provider_verified_at timestamp with time zone, failure_code text, failure_message_safe text, attempt_number integer, idempotency_key text, created_at timestamp with time zone, updated_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_purchase_parent_id UUID;
  v_purchase_status   TEXT;
  v_final_amount      INTEGER;
  v_currency          TEXT;
  v_next_attempt      INTEGER;
  v_attempt_id        UUID;
  v_existing_id       UUID;
BEGIN
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

  -- V0.1.51: the PAYABLE snapshot (after any coupon), never the original price.
  SELECT parent_id, status, final_price_amount, currency
    INTO v_purchase_parent_id, v_purchase_status, v_final_amount, v_currency
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt_purchase_not_found'
      USING HINT = 'Purchase record not found.';
  END IF;

  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'attempt_purchase_not_owner'
      USING HINT = 'This purchase does not belong to you.';
  END IF;

  SELECT pa.id INTO v_existing_id
  FROM public.payment_attempts pa
  WHERE pa.purchase_id = p_purchase_id
    AND pa.idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY
    SELECT pa.*
    FROM public.payment_attempts pa
    WHERE pa.id = v_existing_id;
    RETURN;
  END IF;

  IF v_purchase_status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'attempt_purchase_not_retryable'
      USING HINT = 'This purchase cannot accept new payment attempts.';
  END IF;

  -- V0.1.51: a provider session must never be created for nothing (100% coupon).
  IF v_final_amount <= 0 THEN
    RAISE EXCEPTION 'attempt_nothing_to_charge'
      USING HINT = 'The final price is zero; no provider payment is possible.';
  END IF;

  SELECT COALESCE(MAX(pa.attempt_number), 0) + 1
    INTO v_next_attempt
  FROM public.payment_attempts pa
  WHERE pa.purchase_id = p_purchase_id;

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
    v_final_amount,
    v_currency,
    p_checkout_expires_at,
    v_next_attempt,
    p_idempotency_key
  )
  RETURNING payment_attempts.id INTO v_attempt_id;

  UPDATE public.candy_purchases
  SET active_payment_attempt_id = v_attempt_id,
      payment_provider = trim(p_provider),
      status = CASE WHEN v_purchase_status IN ('failed', 'expired') THEN 'pending' ELSE v_purchase_status END,
      expires_at = COALESCE(p_checkout_expires_at, expires_at),
      failed_at = NULL,
      cancelled_at = NULL
  WHERE candy_purchases.id = p_purchase_id;

  RETURN QUERY
  SELECT pa.*
  FROM public.payment_attempts pa
  WHERE pa.id = v_attempt_id;
END;
$$;

COMMENT ON FUNCTION public.create_payment_attempt_trusted IS 'Trusted payment-attempt creation. Requested amount = the purchase final_price_amount (V0.1.51 fix: was price_amount); a zero final price is refused. Idempotent per (purchase_id, idempotency_key). Points the purchase at the new attempt; failed/expired purchases return to pending.';

-- ───────────────────────────────────────────────────────────────────────────
-- apply_coupon_to_purchase_trusted: verbatim from 0005 except the coupon row is
-- locked FOR UPDATE (marked V0.1.51 below) so usage counting is serialized per
-- coupon.
CREATE OR REPLACE FUNCTION public.apply_coupon_to_purchase_trusted(p_parent_profile_id uuid, p_purchase_id uuid, p_coupon_code text, p_idempotency_key text) RETURNS TABLE(redemption_id uuid, coupon_id uuid, normalized_code text, discount_type text, discount_value integer, original_price_amount integer, discount_amount integer, final_price_amount integer, currency text, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
#variable_conflict use_column
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

  v_code := upper(trim(p_coupon_code));
  IF v_code !~ '^[A-Z0-9_-]{3,32}$' THEN
    RAISE EXCEPTION 'coupon_code_invalid' USING HINT = 'The coupon code format is invalid.';
  END IF;

  SELECT parent_id, status, original_price_amount, currency, package_id, active_payment_attempt_id
    INTO v_purchase_parent_id, v_purchase_status, v_original_price, v_currency,
         v_package_id, v_active_attempt_id
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coupon_purchase_not_found' USING HINT = 'Purchase record not found.';
  END IF;

  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'coupon_purchase_not_owner' USING HINT = 'This purchase does not belong to you.';
  END IF;

  IF v_purchase_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'coupon_purchase_not_pending' USING HINT = 'Only pending purchases accept a coupon.';
  END IF;

  IF v_active_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'coupon_purchase_has_payment_attempt'
      USING HINT = 'A payment attempt already exists for this purchase.';
  END IF;

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

  SELECT id INTO v_existing_redemption_id
  FROM public.coupon_redemptions
  WHERE purchase_id = p_purchase_id AND status IN ('reserved', 'redeemed');

  IF v_existing_redemption_id IS NOT NULL THEN
    RAISE EXCEPTION 'coupon_already_applied' USING HINT = 'A coupon is already applied to this purchase.';
  END IF;

  SELECT id, discount_type, discount_value, is_active, starts_at, expires_at,
         global_usage_limit, per_parent_usage_limit, minimum_purchase_amount,
         maximum_discount_amount
    INTO v_coupon_id, v_discount_type, v_discount_value, v_is_active, v_starts_at,
         v_expires_at, v_global_limit, v_parent_limit, v_minimum_amount, v_maximum_discount
  FROM public.coupons
  WHERE code = v_code
  FOR UPDATE; -- V0.1.51: serializes usage counting per coupon (limit race fix)

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

  v_discount := public.calculate_coupon_discount(
    v_discount_type, v_discount_value, v_original_price, v_maximum_discount
  );

  IF v_discount <= 0 THEN
    RAISE EXCEPTION 'coupon_zero_discount'
      USING HINT = 'This coupon produces no discount for this purchase amount.';
  END IF;

  v_final := v_original_price - v_discount;

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

  UPDATE public.candy_purchases
  SET discount_amount    = v_discount,
      final_price_amount = v_final
  WHERE id = p_purchase_id;

  RETURN QUERY
  SELECT v_redemption_id, v_coupon_id, v_code, v_discount_type, v_discount_value,
         v_original_price, v_discount, v_final, v_currency, 'reserved'::TEXT;
END;
$_$;

-- ───────────────────────────────────────────────────────────────────────────
-- validate_coupon_for_purchase_trusted and record_payment_attempt_session_trusted:
-- verbatim from 0005 plus `#variable_conflict use_column`. Like apply (above)
-- and create_payment_attempt (above), their RETURNS TABLE output names
-- (status, original_price_amount, provider, purchase_id, id, ...) collide with
-- the columns they read, and PostgreSQL refuses the statement at run time
-- ("column reference ... is ambiguous", 42702). Supabase fixed the same defect
-- for create/update_coupon_trusted in 20260925100000; these four were missed
-- and have never worked there either (coupon apply/validate on a purchase
-- failed; the attempt functions had no caller). Same fix, same directive.
CREATE OR REPLACE FUNCTION public.validate_coupon_for_purchase_trusted(p_parent_profile_id uuid, p_purchase_id uuid, p_coupon_code text) RETURNS TABLE(coupon_id uuid, normalized_code text, discount_type text, original_price_amount integer, discount_amount integer, final_price_amount integer, currency text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
#variable_conflict use_column
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

CREATE OR REPLACE FUNCTION public.record_payment_attempt_session_trusted(p_attempt_id uuid, p_provider_session_id text, p_checkout_url text, p_checkout_expires_at timestamp with time zone) RETURNS TABLE(id uuid, purchase_id uuid, provider text, status text, provider_session_id text, provider_transaction_id text, provider_payment_reference text, checkout_url text, checkout_expires_at timestamp with time zone, requested_amount integer, requested_currency text, verified_amount integer, verified_currency text, provider_verified_at timestamp with time zone, failure_code text, failure_message_safe text, attempt_number integer, idempotency_key text, created_at timestamp with time zone, updated_at timestamp with time zone, completed_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
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

-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.confirm_payment_attempt_trusted(
    p_provider text,
    p_provider_event_id text,
    p_provider_session_id text,
    p_provider_transaction_id text,
    p_paid_amount integer,
    p_paid_currency text)
    RETURNS TABLE(outcome text, purchase_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_event_id      uuid;
  v_seen_purchase uuid;
  v_attempt_id    uuid;
  v_attempt_status text;
  v_purchase_id   uuid;
  v_parent_id     uuid;
  v_status        text;
  v_final         integer;
  v_currency      text;
  v_candy         integer;
  v_wallet_id     uuid;
  v_reused        uuid;
BEGIN
  IF p_provider IS NULL OR char_length(trim(p_provider)) = 0
     OR p_provider_event_id IS NULL OR char_length(trim(p_provider_event_id)) = 0
     OR p_provider_session_id IS NULL OR char_length(trim(p_provider_session_id)) = 0
     OR p_provider_transaction_id IS NULL OR char_length(trim(p_provider_transaction_id)) = 0
     OR p_paid_amount IS NULL OR p_paid_currency IS NULL THEN
    RAISE EXCEPTION 'payment_event_invalid';
  END IF;

  -- 1. Event dedupe. The row is part of THIS transaction: if anything below
  --    fails, the event is not recorded either and a provider retry is processed
  --    again. A concurrent identical event waits on the unique index and then
  --    sees the winner's row.
  INSERT INTO public.payment_webhook_events (provider, provider_event_id, event_type, processing_status)
  VALUES (trim(p_provider), trim(p_provider_event_id), 'payment.succeeded', 'received')
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT e.purchase_id INTO v_seen_purchase FROM public.payment_webhook_events e
    WHERE e.provider = trim(p_provider) AND e.provider_event_id = trim(p_provider_event_id);
    RETURN QUERY SELECT 'duplicate_event'::text, v_seen_purchase;
    RETURN;
  END IF;

  -- 2. The attempt this provider session belongs to (unique per provider).
  SELECT pa.id, pa.purchase_id INTO v_attempt_id, v_purchase_id
  FROM public.payment_attempts pa
  WHERE pa.provider = trim(p_provider) AND pa.provider_session_id = trim(p_provider_session_id);

  IF v_attempt_id IS NULL THEN
    UPDATE public.payment_webhook_events SET processing_status = 'ignored', failure_code = 'attempt_not_found', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'attempt_not_found'::text, NULL::uuid;
    RETURN;
  END IF;

  -- 3. Locks in the same order as every other purchase function: purchase, then attempt, then wallet.
  SELECT cp.parent_id, cp.status, cp.final_price_amount, cp.currency, cp.candy_amount
    INTO v_parent_id, v_status, v_final, v_currency, v_candy
  FROM public.candy_purchases cp WHERE cp.id = v_purchase_id FOR UPDATE;

  SELECT pa.status INTO v_attempt_status FROM public.payment_attempts pa WHERE pa.id = v_attempt_id FOR UPDATE;

  UPDATE public.payment_webhook_events SET attempt_id = v_attempt_id, purchase_id = v_purchase_id WHERE id = v_event_id;

  -- 4. Already paid (by this event's twin, a callback, or another attempt): never credit again.
  IF v_status = 'paid' THEN
    UPDATE public.payment_webhook_events SET processing_status = 'ignored', failure_code = 'already_paid', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'already_paid'::text, v_purchase_id;
    RETURN;
  END IF;

  IF v_status = 'cancelled' THEN
    UPDATE public.payment_webhook_events SET processing_status = 'failed', failure_code = 'purchase_cancelled', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'purchase_cancelled'::text, v_purchase_id;
    RETURN;
  END IF;

  -- 5. One provider transaction can fund ONE attempt (also a partial unique index).
  SELECT pa.id INTO v_reused FROM public.payment_attempts pa
  WHERE pa.provider = trim(p_provider) AND pa.provider_transaction_id = trim(p_provider_transaction_id) AND pa.id <> v_attempt_id;
  IF v_reused IS NOT NULL THEN
    UPDATE public.payment_webhook_events SET processing_status = 'failed', failure_code = 'transaction_reused', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'transaction_reused'::text, v_purchase_id;
    RETURN;
  END IF;

  -- 6. The provider must have charged exactly the payable snapshot.
  IF p_paid_amount IS DISTINCT FROM v_final THEN
    UPDATE public.payment_webhook_events SET processing_status = 'failed', failure_code = 'amount_mismatch', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'amount_mismatch'::text, v_purchase_id;
    RETURN;
  END IF;
  IF p_paid_currency IS DISTINCT FROM v_currency THEN
    UPDATE public.payment_webhook_events SET processing_status = 'failed', failure_code = 'currency_mismatch', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'currency_mismatch'::text, v_purchase_id;
    RETURN;
  END IF;

  -- 7. Attempt verified (idx_payment_attempts_verified_once: one per purchase).
  UPDATE public.payment_attempts
  SET status = 'verified',
      provider_transaction_id = trim(p_provider_transaction_id),
      verified_amount = p_paid_amount,
      verified_currency = p_paid_currency,
      provider_verified_at = now(),
      completed_at = now()
  WHERE id = v_attempt_id;

  -- 8. Purchase paid.
  UPDATE public.candy_purchases
  SET status = 'paid',
      paid_at = now(),
      payment_reference = trim(p_provider_transaction_id),
      provider_verified_at = now(),
      active_payment_attempt_id = v_attempt_id,
      failed_at = NULL
  WHERE id = v_purchase_id;

  -- 9. Wallet credit + immutable ledger row (same key as the historical
  --    completion: 'purchase_credit:<purchase>' is UNIQUE, a second guard).
  SELECT cw.id INTO v_wallet_id FROM public.candy_wallets cw WHERE cw.parent_id = v_parent_id FOR UPDATE;
  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'purchase_wallet_not_found';
  END IF;

  UPDATE public.candy_wallets SET balance = balance + v_candy WHERE id = v_wallet_id;

  INSERT INTO public.candy_transactions (wallet_id, amount, type, reference_type, reference_id, description, idempotency_key)
  VALUES (v_wallet_id, v_candy, 'purchase', 'candy_purchase', v_purchase_id::text, 'اعتبار آبنبات بسته خریداری شده', 'purchase_credit:' || v_purchase_id);

  -- 10. A reserved coupon becomes redeemed with the verified payment.
  UPDATE public.coupon_redemptions
  SET status = 'redeemed', redeemed_at = now()
  WHERE coupon_redemptions.purchase_id = v_purchase_id AND status = 'reserved';

  UPDATE public.payment_webhook_events SET processing_status = 'processed', processed_at = now() WHERE id = v_event_id;
  RETURN QUERY SELECT 'processed'::text, v_purchase_id;
END;
$$;

COMMENT ON FUNCTION public.confirm_payment_attempt_trusted IS 'Trusted provider-verified payment confirmation (V0.1.51). Called only after the provider signature (webhook) or a server-to-server provider verification (return route) was checked. Dedupes the provider event, checks amount/currency against the payable snapshot, then atomically: attempt verified, purchase paid, wallet credit, ledger row, coupon redeemed. A paid purchase is never credited again.';

-- ───────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.fail_payment_attempt_trusted(
    p_provider text,
    p_provider_event_id text,
    p_provider_session_id text,
    p_failure_code text)
    RETURNS TABLE(outcome text, purchase_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_event_id      uuid;
  v_seen_purchase uuid;
  v_attempt_id    uuid;
  v_attempt_status text;
  v_purchase_id   uuid;
  v_status        text;
  v_active        uuid;
  v_code          text;
BEGIN
  IF p_provider IS NULL OR char_length(trim(p_provider)) = 0
     OR p_provider_event_id IS NULL OR char_length(trim(p_provider_event_id)) = 0
     OR p_provider_session_id IS NULL OR char_length(trim(p_provider_session_id)) = 0 THEN
    RAISE EXCEPTION 'payment_event_invalid';
  END IF;
  v_code := left(coalesce(nullif(trim(p_failure_code), ''), 'provider_failed'), 64);

  INSERT INTO public.payment_webhook_events (provider, provider_event_id, event_type, processing_status)
  VALUES (trim(p_provider), trim(p_provider_event_id), 'payment.failed', 'received')
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT e.purchase_id INTO v_seen_purchase FROM public.payment_webhook_events e
    WHERE e.provider = trim(p_provider) AND e.provider_event_id = trim(p_provider_event_id);
    RETURN QUERY SELECT 'duplicate_event'::text, v_seen_purchase;
    RETURN;
  END IF;

  SELECT pa.id, pa.purchase_id INTO v_attempt_id, v_purchase_id
  FROM public.payment_attempts pa
  WHERE pa.provider = trim(p_provider) AND pa.provider_session_id = trim(p_provider_session_id);

  IF v_attempt_id IS NULL THEN
    UPDATE public.payment_webhook_events SET processing_status = 'ignored', failure_code = 'attempt_not_found', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'attempt_not_found'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT cp.status, cp.active_payment_attempt_id INTO v_status, v_active
  FROM public.candy_purchases cp WHERE cp.id = v_purchase_id FOR UPDATE;
  SELECT pa.status INTO v_attempt_status FROM public.payment_attempts pa WHERE pa.id = v_attempt_id FOR UPDATE;

  UPDATE public.payment_webhook_events SET attempt_id = v_attempt_id, purchase_id = v_purchase_id WHERE id = v_event_id;

  -- A late "failed" never regresses a verified attempt or a paid purchase.
  IF v_attempt_status = 'verified' OR v_status = 'paid' THEN
    UPDATE public.payment_webhook_events SET processing_status = 'ignored', failure_code = 'already_paid', processed_at = now() WHERE id = v_event_id;
    RETURN QUERY SELECT 'already_paid'::text, v_purchase_id;
    RETURN;
  END IF;

  IF v_attempt_status NOT IN ('failed', 'cancelled', 'expired') THEN
    UPDATE public.payment_attempts
    SET status = 'failed', failure_code = v_code, completed_at = now()
    WHERE id = v_attempt_id;
  END IF;

  -- Only the purchase's CURRENT attempt failing fails the purchase (an older
  -- attempt's late failure must not undo a newer one). No wallet, ledger or
  -- coupon effect: the reserved coupon stays with the purchase for a retry.
  IF v_status = 'pending' AND v_active IS NOT DISTINCT FROM v_attempt_id THEN
    UPDATE public.candy_purchases SET status = 'failed', failed_at = now() WHERE id = v_purchase_id;
  END IF;

  UPDATE public.payment_webhook_events SET processing_status = 'processed', processed_at = now() WHERE id = v_event_id;
  RETURN QUERY SELECT 'processed'::text, v_purchase_id;
END;
$$;

COMMENT ON FUNCTION public.fail_payment_attempt_trusted IS 'Trusted provider-verified payment failure (V0.1.51). Dedupes the event; marks the attempt failed and, if it is the current attempt of a pending purchase, the purchase failed. Never touches a verified attempt or a paid purchase; no money moves.';

-- ───────────────────────────────────────────────────────────────────────────
-- Privileges. EXECUTE only on what the backend calls; SELECT only where it reads.
REVOKE ALL ON FUNCTION public.create_candy_purchase_trusted(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_attempt_trusted(uuid, uuid, text, timestamp with time zone, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_coupon_to_purchase_trusted(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_payment_attempt_trusted(text, text, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_payment_attempt_trusted(text, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_candy_purchase_trusted(uuid, uuid) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.apply_coupon_to_purchase_trusted(uuid, uuid, text, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.validate_coupon_for_purchase_trusted(uuid, uuid, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.create_payment_attempt_trusted(uuid, uuid, text, timestamp with time zone, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.record_payment_attempt_session_trusted(uuid, text, text, timestamp with time zone) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.confirm_payment_attempt_trusted(text, text, text, text, integer, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.fail_payment_attempt_trusted(text, text, text, text) TO cartoona_app;
-- Admin coupon management moves with redemptions (one database for limits).
GRANT EXECUTE ON FUNCTION public.create_coupon_trusted(uuid, text, text, text, text, integer, boolean, timestamp with time zone, timestamp with time zone, integer, integer, integer, integer, uuid[]) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.update_coupon_trusted(uuid, uuid, timestamp with time zone, text, text, text, text, integer, boolean, timestamp with time zone, timestamp with time zone, integer, integer, integer, integer, uuid[]) TO cartoona_app;

GRANT SELECT ON public.candy_packages, public.candy_purchases, public.coupons, public.coupon_package_rules, public.coupon_redemptions TO cartoona_app;
-- Attempts: only what ownership checks and the "payment started" flag need -
-- never provider references or checkout URLs.
GRANT SELECT (id, purchase_id, status) ON public.payment_attempts TO cartoona_app;

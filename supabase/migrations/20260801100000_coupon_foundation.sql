-- Migration: coupon_foundation
-- Server-authoritative coupon system for candy-package purchases.
-- No real payment provider integration. No seed coupons. No wallet/ledger
-- changes. No purchase creation. DDL + trusted service-role-only RPCs only.
--
-- Monetary policy (documented, enforced by comment convention):
--   * All stored amounts are INTEGER RIAL (IRR). Do not convert, rename to
--     toman, or rescale.
--   * Percentage discounts are expressed as integer BASIS POINTS.
--     1000 basis points = 10%. 10000 basis points = 100%.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. coupons — the coupon catalogue (no seed rows in this migration)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coupons (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT,
  discount_type           TEXT NOT NULL,
  discount_value          INTEGER NOT NULL,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at               TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ,
  global_usage_limit      INTEGER,
  per_parent_usage_limit  INTEGER,
  minimum_purchase_amount INTEGER,
  maximum_discount_amount INTEGER,
  created_by_user_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT coupons_code_normalized_check
    CHECK (code = upper(trim(code)) AND code ~ '^[A-Z0-9_-]{3,32}$'),
  CONSTRAINT coupons_name_nonempty_check
    CHECK (char_length(trim(name)) > 0),
  CONSTRAINT coupons_discount_type_check
    CHECK (discount_type IN ('percentage', 'fixed_amount')),
  CONSTRAINT coupons_discount_value_check
    CHECK (
      (discount_type = 'percentage'   AND discount_value BETWEEN 1 AND 10000)
      OR
      (discount_type = 'fixed_amount' AND discount_value > 0)
    ),
  CONSTRAINT coupons_global_limit_positive_check
    CHECK (global_usage_limit IS NULL OR global_usage_limit > 0),
  CONSTRAINT coupons_parent_limit_positive_check
    CHECK (per_parent_usage_limit IS NULL OR per_parent_usage_limit > 0),
  CONSTRAINT coupons_minimum_amount_nonnegative_check
    CHECK (minimum_purchase_amount IS NULL OR minimum_purchase_amount >= 0),
  CONSTRAINT coupons_maximum_discount_positive_check
    CHECK (maximum_discount_amount IS NULL OR maximum_discount_amount > 0),
  CONSTRAINT coupons_dates_order_check
    CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);

COMMENT ON TABLE public.coupons IS
  'Server-authoritative coupon catalogue. Coupon codes are normalized to '
  'UPPERCASE and matched case-insensitively. No parent may query this table '
  'directly (code enumeration protection); admins may SELECT. Zero rows are '
  'seeded by migration — coupons are created only after commercial approval.';

COMMENT ON COLUMN public.coupons.code IS
  'Normalized coupon code: uppercase A-Z, 0-9, hyphen, underscore, 3-32 chars. '
  'Stored already normalized; CHECK enforces code = upper(trim(code)).';
COMMENT ON COLUMN public.coupons.discount_type IS
  'percentage | fixed_amount. Percentage values are integer basis points.';
COMMENT ON COLUMN public.coupons.discount_value IS
  'Percentage: integer basis points (1000 = 10%, min 1, max 10000). '
  'Fixed amount: positive integer RIAL (IRR).';
COMMENT ON COLUMN public.coupons.minimum_purchase_amount IS
  'Minimum original purchase amount in integer RIAL required before discount. NULL = no minimum.';
COMMENT ON COLUMN public.coupons.maximum_discount_amount IS
  'Cap on the calculated discount in integer RIAL. Applied after percentage '
  'calculation. NULL = no cap.';
COMMENT ON COLUMN public.coupons.created_by_user_id IS
  'Admin user who created the coupon (public.users). NULL if created outside the app.';

-- Unique code: uniqueness enforced in the database (case-insensitive because
-- the CHECK guarantees codes are stored uppercase).
ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_code_unique UNIQUE (code);

-- Lookup index for code-based validation and active/date scanning.
CREATE INDEX IF NOT EXISTS idx_coupons_active_lookup
  ON public.coupons (is_active, starts_at, expires_at);

-- Updated_at trigger (reuses public.set_updated_at from 20260717090000)
DROP TRIGGER IF EXISTS coupons_set_updated_at ON public.coupons;
CREATE TRIGGER coupons_set_updated_at
  BEFORE UPDATE ON public.coupons
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. coupon_package_rules — package restrictions
--    No rows for a coupon ⇒ applies to all active packages.
--    One or more rows ⇒ applies only to those packages.
--    Never duplicates package price or candy amount.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coupon_package_rules (
  coupon_id  UUID NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES public.candy_packages(id) ON DELETE CASCADE,
  PRIMARY KEY (coupon_id, package_id)
);

COMMENT ON TABLE public.coupon_package_rules IS
  'Package restrictions per coupon. Zero rows for a coupon = applies to ALL '
  'active packages. One or more rows = applies ONLY to those packages. '
  'Contains package IDs only — never duplicated price or candy amounts.';

-- Reverse lookup index (find all coupons restricted to a given package).
CREATE INDEX IF NOT EXISTS idx_coupon_package_rules_package
  ON public.coupon_package_rules (package_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. coupon_redemptions — one redemption record per couponed purchase
--    UNIQUE (purchase_id) guarantees at most one coupon per purchase.
--    Snapshots capture the exact discount applied at apply-time.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.coupon_redemptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id                UUID NOT NULL REFERENCES public.coupons(id),
  purchase_id              UUID NOT NULL REFERENCES public.candy_purchases(id),
  parent_profile_id        UUID NOT NULL REFERENCES public.parent_profiles(id),
  normalized_code_snapshot TEXT NOT NULL,
  discount_type_snapshot   TEXT NOT NULL,
  discount_value_snapshot  INTEGER NOT NULL,
  original_price_amount    INTEGER NOT NULL,
  discount_amount          INTEGER NOT NULL,
  final_price_amount       INTEGER NOT NULL,
  currency                 TEXT NOT NULL,
  status                   TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at              TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  CONSTRAINT coupon_redemptions_type_check
    CHECK (discount_type_snapshot IN ('percentage', 'fixed_amount')),
  CONSTRAINT coupon_redemptions_value_positive_check
    CHECK (discount_value_snapshot > 0),
  CONSTRAINT coupon_redemptions_original_positive_check
    CHECK (original_price_amount > 0),
  CONSTRAINT coupon_redemptions_discount_nonnegative_check
    CHECK (discount_amount >= 0),
  CONSTRAINT coupon_redemptions_final_nonnegative_check
    CHECK (final_price_amount >= 0),
  CONSTRAINT coupon_redemptions_price_consistency_check
    CHECK (original_price_amount - discount_amount = final_price_amount),
  CONSTRAINT coupon_redemptions_currency_nonempty_check
    CHECK (char_length(trim(currency)) > 0),
  CONSTRAINT coupon_redemptions_status_check
    CHECK (status IN ('reserved', 'redeemed', 'cancelled'))
);

COMMENT ON TABLE public.coupon_redemptions IS
  'One row per coupon applied to a purchase. UNIQUE (purchase_id) enforces at '
  'most one coupon per purchase. status: reserved → redeemed (verified paid) '
  'or cancelled. All monetary values are integer RIAL (IRR). Percentage '
  'snapshots are integer basis points.';

COMMENT ON COLUMN public.coupon_redemptions.normalized_code_snapshot IS
  'Normalized coupon code at apply time (audit).';
COMMENT ON COLUMN public.coupon_redemptions.discount_type_snapshot IS
  'Discount type at apply time.';
COMMENT ON COLUMN public.coupon_redemptions.discount_value_snapshot IS
  'Discount value at apply time (basis points for percentage, RIAL for fixed).';
COMMENT ON COLUMN public.coupon_redemptions.original_price_amount IS
  'Purchase original price snapshot in integer RIAL (equals candy_purchases.original_price_amount).';
COMMENT ON COLUMN public.coupon_redemptions.discount_amount IS
  'Discount applied in integer RIAL.';
COMMENT ON COLUMN public.coupon_redemptions.final_price_amount IS
  'Payable amount after discount in integer RIAL.';
COMMENT ON COLUMN public.coupon_redemptions.idempotency_key IS
  'Server-side idempotency key for apply. UNIQUE per purchase. Never timestamp-only.';
COMMENT ON COLUMN public.coupon_redemptions.status IS
  'reserved = applied to a pending purchase; redeemed = purchase paid+verified; '
  'cancelled = purchase cancelled/expired and reservation released.';

-- At most one coupon per purchase (no stacking).
ALTER TABLE public.coupon_redemptions
  ADD CONSTRAINT coupon_redemptions_purchase_unique UNIQUE (purchase_id);

-- Idempotent apply: same (purchase_id, idempotency_key) returns the existing row.
ALTER TABLE public.coupon_redemptions
  ADD CONSTRAINT coupon_redemptions_purchase_idempotency_unique
  UNIQUE (purchase_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_id
  ON public.coupon_redemptions (coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_parent_status
  ON public.coupon_redemptions (parent_profile_id, status);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. candy_purchases — explicit pricing snapshot additions
--    Preserves price_amount as the original package price snapshot (backward
--    compatible). Adds original_price_amount (explicit alias), discount_amount,
--    and final_price_amount. Future payment attempts must use final_price_amount.
--    Safe backfill for non-empty environments: existing purchases get
--    original = final = price_amount, discount = 0.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_purchases
  ADD COLUMN IF NOT EXISTS original_price_amount INTEGER;
ALTER TABLE public.candy_purchases
  ADD COLUMN IF NOT EXISTS discount_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.candy_purchases
  ADD COLUMN IF NOT EXISTS final_price_amount INTEGER;

-- Backfill existing purchases (safe no-op when table is empty).
UPDATE public.candy_purchases
SET original_price_amount = price_amount,
    discount_amount       = 0,
    final_price_amount    = price_amount
WHERE original_price_amount IS NULL OR final_price_amount IS NULL;

-- Now enforce NOT NULL and consistency.
ALTER TABLE public.candy_purchases
  ALTER COLUMN original_price_amount SET NOT NULL;
ALTER TABLE public.candy_purchases
  ALTER COLUMN final_price_amount SET NOT NULL;

ALTER TABLE public.candy_purchases
  ADD CONSTRAINT candy_purchases_original_price_positive_check
  CHECK (original_price_amount > 0);
ALTER TABLE public.candy_purchases
  ADD CONSTRAINT candy_purchases_discount_nonnegative_check
  CHECK (discount_amount >= 0);
ALTER TABLE public.candy_purchases
  ADD CONSTRAINT candy_purchases_final_price_nonnegative_check
  CHECK (final_price_amount >= 0);
-- Enforce the documented invariant: price_amount is the original package
-- price snapshot, and final = original − discount.
ALTER TABLE public.candy_purchases
  ADD CONSTRAINT candy_purchases_price_snapshot_invariant_check
  CHECK (original_price_amount = price_amount
         AND original_price_amount - discount_amount = final_price_amount);

COMMENT ON COLUMN public.candy_purchases.price_amount IS
  'Original package price snapshot in integer RIAL (IRR). Backward-compatible '
  'alias of the pre-discount amount; equals original_price_amount.';
COMMENT ON COLUMN public.candy_purchases.original_price_amount IS
  'Explicit original (pre-discount) package price snapshot in integer RIAL. '
  'Equals price_amount by constraint.';
COMMENT ON COLUMN public.candy_purchases.discount_amount IS
  'Coupon discount applied in integer RIAL. Zero when no coupon is applied.';
COMMENT ON COLUMN public.candy_purchases.final_price_amount IS
  'Payable amount after discount in integer RIAL. Payment provider attempts '
  'must charge this amount (never price_amount). Equals original − discount.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. RLS and grants
--    coupons + coupon_package_rules: admin/super_admin SELECT only. No parent
--    access (prevents coupon enumeration). No browser writes.
--    coupon_redemptions: parent SELECT own, admin SELECT all, no browser writes.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_package_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.coupons FROM anon;
REVOKE ALL ON public.coupons FROM authenticated;
REVOKE ALL ON public.coupon_package_rules FROM anon;
REVOKE ALL ON public.coupon_package_rules FROM authenticated;
REVOKE ALL ON public.coupon_redemptions FROM anon;
REVOKE ALL ON public.coupon_redemptions FROM authenticated;

-- Admin / super_admin may SELECT all coupons and rules (no browser writes).
CREATE POLICY coupons_select_admin ON public.coupons
  FOR SELECT TO authenticated
  USING (public.is_admin_or_super_admin());

CREATE POLICY coupon_package_rules_select_admin ON public.coupon_package_rules
  FOR SELECT TO authenticated
  USING (public.is_admin_or_super_admin());

-- Parents may read ONLY their own redemption records (future history view).
-- No INSERT/UPDATE/DELETE for any browser role.
CREATE POLICY coupon_redemptions_select_own ON public.coupon_redemptions
  FOR SELECT TO authenticated
  USING (
    public.is_parent()
    AND parent_profile_id = public.current_parent_profile_id()
  );

CREATE POLICY coupon_redemptions_select_admin ON public.coupon_redemptions
  FOR SELECT TO authenticated
  USING (public.is_admin_or_super_admin());

GRANT SELECT ON public.coupons TO authenticated;
GRANT SELECT ON public.coupon_package_rules TO authenticated;
GRANT SELECT ON public.coupon_redemptions TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Discount calculation helpers (pure, integer-only)
--    PERCENTAGE: discount = floor(original * basis_points / 10000)
--                then capped by maximum_discount_amount when present.
--    FIXED:      discount = min(discount_value, original_price_amount)
--                then capped by maximum_discount_amount when present.
--    Rounding rule: integer division with floor. No floating point.
--    A percentage that computes to zero is rejected (coupon_zero_discount).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.calculate_coupon_discount(
  p_discount_type TEXT,
  p_discount_value INTEGER,
  p_original_price INTEGER,
  p_maximum_discount_amount INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_discount INTEGER;
BEGIN
  IF p_discount_type = 'percentage' THEN
    v_discount := (p_original_price * p_discount_value) / 10000;
  ELSE
    v_discount := LEAST(p_discount_value, p_original_price);
  END IF;

  IF p_maximum_discount_amount IS NOT NULL AND v_discount > p_maximum_discount_amount THEN
    v_discount := p_maximum_discount_amount;
  END IF;

  RETURN v_discount;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_coupon_discount(TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_coupon_discount(TEXT, INTEGER, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.calculate_coupon_discount(TEXT, INTEGER, INTEGER, INTEGER) FROM authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. validate_coupon_for_purchase_trusted — read-only validation
--    service_role only. Creates nothing, updates nothing, credits nothing.
--    Returns a safe validation result for a pending purchase.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.validate_coupon_for_purchase_trusted(
  p_parent_profile_id UUID,
  p_purchase_id UUID,
  p_coupon_code TEXT
)
RETURNS TABLE (
  coupon_id             UUID,
  normalized_code       TEXT,
  discount_type         TEXT,
  original_price_amount INTEGER,
  discount_amount       INTEGER,
  final_price_amount    INTEGER,
  currency              TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

COMMENT ON FUNCTION public.validate_coupon_for_purchase_trusted IS
  'Trusted server-only, READ-ONLY coupon validation for a pending purchase. '
  'Callable only by service_role. Normalizes the code, verifies purchase '
  'ownership/pending/no-payment-attempt/no-existing-coupon, validates the '
  'coupon (active, dates, limits, package, minimum), and returns the computed '
  'discount. Creates NOTHING, updates nothing.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. apply_coupon_to_purchase_trusted — atomic, idempotent apply
--    service_role only. Locks purchase, re-validates, records the redemption
--    and updates purchase discount/final amounts atomically.
--    Does NOT create a payment attempt, does NOT credit/debit the wallet.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_coupon_to_purchase_trusted(
  p_parent_profile_id UUID,
  p_purchase_id UUID,
  p_coupon_code TEXT,
  p_idempotency_key TEXT
)
RETURNS TABLE (
  redemption_id         UUID,
  coupon_id             UUID,
  normalized_code       TEXT,
  discount_type         TEXT,
  discount_value        INTEGER,
  original_price_amount INTEGER,
  discount_amount       INTEGER,
  final_price_amount    INTEGER,
  currency              TEXT,
  status                TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

COMMENT ON FUNCTION public.apply_coupon_to_purchase_trusted IS
  'Trusted server-only, atomic coupon application. Callable only by service_role. '
  'Locks the purchase FOR UPDATE, re-validates the coupon inside the transaction, '
  'inserts the redemption row (status=reserved) with snapshots, and updates '
  'candy_purchases discount_amount/final_price_amount. Idempotent: retrying with '
  'the same (purchase_id, idempotency_key) returns the existing redemption. '
  'A different coupon on an already-discounted purchase is rejected. Does NOT '
  'create a payment attempt and does NOT touch the wallet or ledger.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. RPC execution privileges — service_role only
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.validate_coupon_for_purchase_trusted(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_coupon_for_purchase_trusted(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.validate_coupon_for_purchase_trusted(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.validate_coupon_for_purchase_trusted(UUID, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.apply_coupon_to_purchase_trusted(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_coupon_to_purchase_trusted(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.apply_coupon_to_purchase_trusted(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_coupon_to_purchase_trusted(UUID, UUID, TEXT, TEXT) TO service_role;

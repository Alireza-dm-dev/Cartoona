-- Migration: candy_purchase_foundation
-- Creates the internal foundation for users purchasing candies.
-- No payment gateway integration. Development-only completion RPC.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 1 — Candy Packages catalog
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.candy_packages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (char_length(trim(name)) > 0),
  description   TEXT,
  candy_amount  INTEGER NOT NULL CHECK (candy_amount > 0),
  price_amount  INTEGER NOT NULL CHECK (price_amount > 0),
  currency      TEXT NOT NULL DEFAULT 'IRR',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.candy_packages IS
  'Predefined candy purchase packages. Active packages are visible to authenticated users for purchase.';

COMMENT ON COLUMN public.candy_packages.name IS 'Human-readable package name (e.g. Starter, Growth, Premium).';
COMMENT ON COLUMN public.candy_packages.description IS 'Optional marketing or descriptive text.';
COMMENT ON COLUMN public.candy_packages.candy_amount IS 'Number of candies the purchaser receives. Must be positive.';
COMMENT ON COLUMN public.candy_packages.price_amount IS 'Price in the smallest currency unit (e.g. Rials). Must be positive.';
COMMENT ON COLUMN public.candy_packages.currency IS 'ISO 4217 currency code (default IRR).';
COMMENT ON COLUMN public.candy_packages.is_active IS 'Controls catalog visibility. Inactive packages cannot be purchased.';
COMMENT ON COLUMN public.candy_packages.display_order IS 'Ascending sort order for UI presentation.';

-- Updated_at trigger
DROP TRIGGER IF EXISTS candy_packages_set_updated_at ON public.candy_packages;
CREATE TRIGGER candy_packages_set_updated_at
  BEFORE UPDATE ON public.candy_packages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- Seed initial packages
-- ═════════════════════════════════════════════════════════════════════════════
-- Values are placeholders. Prices and amounts will change when payment
-- gateway integration begins. The catalog is designed for easy updates.

INSERT INTO public.candy_packages (name, description, candy_amount, price_amount, display_order)
VALUES
  ('استارتر', 'بسته شروع — ۱۰۰ آبنبات برای شروع ماجراجویی', 100, 50000, 1),
  ('رشد', 'بسته رشد — ۳۰۰ آبنبات برای سفارش‌های بیشتر', 300, 135000, 2),
  ('ممتاز', 'بسته ممتاز — ۷۰۰ آبنبات به همراه اندکی هدیه', 700, 280000, 3)
ON CONFLICT DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS — candy_packages
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_packages ENABLE ROW LEVEL SECURITY;

-- Authenticated users: SELECT active packages only
CREATE POLICY candy_packages_select_active ON public.candy_packages
  FOR SELECT
  TO authenticated
  USING (is_active = TRUE);

-- Admin / super_admin: SELECT all packages (active or inactive)
CREATE POLICY candy_packages_select_admin ON public.candy_packages
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- No INSERT/UPDATE/DELETE policies for any client role.
-- Package management is done through direct database access (admin).

REVOKE ALL ON public.candy_packages FROM anon;
REVOKE ALL ON public.candy_packages FROM authenticated;
GRANT SELECT ON public.candy_packages TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 2 — Purchase records
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.candy_purchases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id         UUID NOT NULL REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  package_id        UUID NOT NULL REFERENCES public.candy_packages(id),
  candy_amount      INTEGER NOT NULL CHECK (candy_amount > 0),
  price_amount      INTEGER NOT NULL CHECK (price_amount > 0),
  currency          TEXT NOT NULL DEFAULT 'IRR',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  payment_reference TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
);

COMMENT ON TABLE public.candy_purchases IS
  'Records of candy purchase attempts. Status lifecycle: pending → paid | failed | cancelled.';

COMMENT ON COLUMN public.candy_purchases.parent_id IS 'Parent who initiated the purchase.';
COMMENT ON COLUMN public.candy_purchases.package_id IS 'The candy package selected for purchase.';
COMMENT ON COLUMN public.candy_purchases.candy_amount IS 'Candy amount at time of purchase (snapshot from package).';
COMMENT ON COLUMN public.candy_purchases.price_amount IS 'Price at time of purchase (snapshot from package).';
COMMENT ON COLUMN public.candy_purchases.status IS 'pending | paid | failed | cancelled.';
COMMENT ON COLUMN public.candy_purchases.payment_reference IS 'External payment reference. NULL until payment completes.';
COMMENT ON COLUMN public.candy_purchases.paid_at IS 'Timestamp when payment was confirmed. NULL until paid.';

-- Updated_at trigger
DROP TRIGGER IF EXISTS candy_purchases_set_updated_at ON public.candy_purchases;
CREATE TRIGGER candy_purchases_set_updated_at
  BEFORE UPDATE ON public.candy_purchases
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS — candy_purchases
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_purchases ENABLE ROW LEVEL SECURITY;

-- Authenticated users: no direct access (created/updated via RPC)
REVOKE ALL ON public.candy_purchases FROM anon;
REVOKE ALL ON public.candy_purchases FROM authenticated;

-- Parent: SELECT own purchases
CREATE POLICY candy_purchases_select_own ON public.candy_purchases
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.parent_profiles
      WHERE parent_profiles.id = candy_purchases.parent_id
        AND parent_profiles.user_id = auth.uid()
    )
  );

-- Admin / super_admin: SELECT all purchases
CREATE POLICY candy_purchases_select_admin ON public.candy_purchases
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- Grant only SELECT (writes via RPC)
GRANT SELECT ON public.candy_purchases TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 3 — Payment completion RPC
-- ═════════════════════════════════════════════════════════════════════════════
-- Development-only simulation. Does NOT call any payment gateway.
-- Marked clearly as development-only — remove when real payment is integrated.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.complete_candy_purchase(
  p_purchase_id UUID,
  p_payment_reference TEXT
)
RETURNS TABLE (
  purchase_id     UUID,
  purchase_status TEXT,
  wallet_id       UUID,
  wallet_balance  INTEGER,
  ledger_entry_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id       UUID;
  v_parent_id     UUID;
  v_purchase_parent_id UUID;
  v_purchase_status TEXT;
  v_candy_amount  INTEGER;
  v_wallet_id     UUID;
  v_ledger_id     UUID;
  v_existing_ledger_id UUID;
  v_credit_key    TEXT;
BEGIN
  -- ═════════════════════════════════════════════════════════════════════════
  -- 1. Authentication check
  -- ═════════════════════════════════════════════════════════════════════════
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'purchase_unauthenticated'
      USING HINT = 'Authentication required.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 2. Parent role check (reject admin/super_admin callers)
  -- ═════════════════════════════════════════════════════════════════════════
  IF EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND role IN ('admin', 'super_admin')) THEN
    RAISE EXCEPTION 'purchase_parent_required'
      USING HINT = 'Only parent accounts can complete purchases.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND role = 'parent') THEN
    RAISE EXCEPTION 'purchase_parent_required'
      USING HINT = 'Parent role required.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 3. Resolve parent profile
  -- ═════════════════════════════════════════════════════════════════════════
  SELECT id INTO v_parent_id
  FROM public.parent_profiles
  WHERE user_id = v_user_id;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'purchase_parent_profile_missing'
      USING HINT = 'Parent profile not found.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 4. Lock purchase row FOR UPDATE
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
  -- 5. Ensure purchase belongs to this parent
  -- ═════════════════════════════════════════════════════════════════════════
  IF v_purchase_parent_id IS DISTINCT FROM v_parent_id THEN
    RAISE EXCEPTION 'purchase_not_owner'
      USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 6. Ensure status is pending
  -- ═════════════════════════════════════════════════════════════════════════
  IF v_purchase_status IS DISTINCT FROM 'pending' THEN
    -- If already paid, return current state without re-crediting
    IF v_purchase_status = 'paid' THEN
      -- Check if ledger entry already exists for idempotent return
      v_credit_key := 'purchase_credit:' || p_purchase_id;
      SELECT id INTO v_existing_ledger_id
      FROM public.candy_transactions
      WHERE idempotency_key = v_credit_key;

      IF v_existing_ledger_id IS NOT NULL THEN
        -- Already processed — return current state idempotently
        RETURN QUERY
        SELECT
          p_purchase_id,
          'paid'::TEXT,
          cw.id,
          cw.balance,
          v_existing_ledger_id
        FROM public.candy_wallets cw
        WHERE cw.parent_id = v_parent_id;
        RETURN;
      END IF;
    END IF;

    RAISE EXCEPTION 'purchase_not_pending'
      USING HINT = 'Only pending purchases can be completed.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 7. Update purchase to paid
  -- ═════════════════════════════════════════════════════════════════════════
  UPDATE public.candy_purchases
  SET status = 'paid',
      payment_reference = COALESCE(p_payment_reference, payment_reference),
      paid_at = now()
  WHERE id = p_purchase_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 8. Lock wallet and credit balance
  -- ═════════════════════════════════════════════════════════════════════════
  SELECT id INTO v_wallet_id
  FROM public.candy_wallets
  WHERE parent_id = v_parent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_wallet_not_found'
      USING HINT = 'Candy wallet not found.';
  END IF;

  UPDATE public.candy_wallets
  SET balance = balance + v_candy_amount
  WHERE id = v_wallet_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 9. Insert immutable ledger entry
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
  -- 10. Return updated state
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

COMMENT ON FUNCTION public.complete_candy_purchase IS
  '[DEVELOPMENT-ONLY] Simulates payment completion for a candy purchase. '
  'Credits the parent wallet and appends an immutable ledger entry. '
  'Idempotent — calling again with the same purchase_id returns current state without double-crediting. '
  'REMOVE or REPLACE when real payment gateway is integrated.';

-- ═════════════════════════════════════════════════════════════════════════════
-- RPC execution grants
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.complete_candy_purchase(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_candy_purchase(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.complete_candy_purchase(UUID, TEXT) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Extend the candy_transactions type CHECK to include 'purchase_credit'
-- ═════════════════════════════════════════════════════════════════════════════
-- Wait — the existing CHECK uses 'purchase' not 'purchase_credit'.
-- The type column already allows 'purchase'. The RPC uses type = 'purchase'
-- which matches the existing constraint. No schema change needed here.

-- However, we need to ensure the CHECK includes the correct types.
-- The existing constraint from migration 20260726110000 is:
--   CHECK (type IN ('purchase', 'spend', 'refund', 'grant', 'order_debit'))
-- 'purchase' is already covered. No action needed.

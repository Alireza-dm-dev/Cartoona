-- Migration: creation_pricing_catalog
-- Creates the authoritative database-backed creation-pricing catalog
-- and seeds it with the exact current candy costs.
--
-- Background:
--   Cartoona currently duplicates creation candy costs between the
--   create_parent_request RPC (SQL) and config/candy-costs.ts (TypeScript).
--   This migration creates the single-source-of-truth pricing table.
--
--   create_parent_request still uses its existing hardcoded SQL pricing.
--   config/candy-costs.ts remains temporarily duplicated.
--   The RPC and TypeScript constants will be replaced in later migrations.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. CREATE TABLE — public.creation_pricing
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.creation_pricing (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_key  TEXT NOT NULL,
  candy_cost   INTEGER NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX idx_creation_pricing_key
  ON public.creation_pricing (pricing_key);

ALTER TABLE public.creation_pricing
  ADD CONSTRAINT creation_pricing_cost_positive
    CHECK (candy_cost > 0);

ALTER TABLE public.creation_pricing
  ADD CONSTRAINT creation_pricing_key_not_empty
    CHECK (pg_catalog.btrim(pricing_key) <> '');

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. SEED — Exact current pricing components
--
-- Nine rows: seven base prices + two reusable surcharges.
-- drawing_animation has no reference-file surcharge (matching SQL and TS).
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO public.creation_pricing (pricing_key, candy_cost) VALUES
  ('image.default',            12),
  ('image.reference_file',      3),
  ('video.short',              40),
  ('video.medium',             60),
  ('video.long',               90),
  ('video.reference_file',      5),
  ('drawing_animation.short',  35),
  ('drawing_animation.medium', 50),
  ('drawing_animation.long',   75);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. COMMENTS
-- ═════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE public.creation_pricing
IS 'Authoritative creation-pricing catalog. pricing_key maps request type+options to a candy cost. Only active rows are publicly visible.';

COMMENT ON COLUMN public.creation_pricing.pricing_key
IS 'Stable machine-readable identifier. Never contains the numeric price or Persian labels.';

COMMENT ON COLUMN public.creation_pricing.candy_cost
IS 'Positive integer — candy cost for this pricing component. Base prices and surcharges are additive.';

COMMENT ON COLUMN public.creation_pricing.is_active
IS 'Controls public visibility and RPC eligibility. Inactive rows are hidden from non-admin queries and cannot be used for new order costing.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. UPDATED_AT TRIGGER
--     Reuses the existing public.set_updated_at() from migration 20260717090000.
-- ═════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS creation_pricing_set_updated_at ON public.creation_pricing;

CREATE TRIGGER creation_pricing_set_updated_at
  BEFORE UPDATE ON public.creation_pricing
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.creation_pricing ENABLE ROW LEVEL SECURITY;

-- Anon / authenticated: SELECT only active prices
CREATE POLICY creation_pricing_select_active ON public.creation_pricing
  FOR SELECT
  USING (is_active = TRUE);

-- Admin / super_admin: SELECT all prices (active + inactive)
CREATE POLICY creation_pricing_select_admin ON public.creation_pricing
  FOR SELECT
  USING (public.is_admin_or_super_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. GRANTS
--     Revoke all default privileges, then grant only SELECT.
--     No browser role may INSERT, UPDATE, DELETE, or TRUNCATE.
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON public.creation_pricing FROM PUBLIC;
REVOKE ALL ON public.creation_pricing FROM anon;
REVOKE ALL ON public.creation_pricing FROM authenticated;

GRANT SELECT ON public.creation_pricing TO anon, authenticated;

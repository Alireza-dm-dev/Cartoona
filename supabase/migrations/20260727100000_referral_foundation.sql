-- Migration: referral_foundation
-- Adds referral code to parent_profiles, referral program settings table,
-- and referral relationships table with RLS.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. REFERRAL CODE GENERATION FUNCTION
-- ═════════════════════════════════════════════════════════════════════════════
-- Generates a unique parent referral code: CT + 12 uppercase hex characters.
-- Uses cryptographically random bytes from pgcrypto via the extensions schema.
-- Retries up to 20 times on collision.

CREATE OR REPLACE FUNCTION public.generate_parent_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code TEXT;
  v_attempt INT := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 20 THEN
      RAISE EXCEPTION 'ERR_REFERRAL_CODE_EXHAUSTED'
        USING HINT = 'Could not generate a unique referral code after 20 attempts.';
    END IF;

    v_code := 'CT' || pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(6), 'hex'));

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.parent_profiles WHERE referral_code = v_code
    );
  END LOOP;

  RETURN v_code;
END;
$$;

COMMENT ON FUNCTION public.generate_parent_referral_code()
IS 'Generates a unique parent referral code (CT + 12 uppercase hex chars). Retries up to 20 times on collision.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. ADD REFERRAL_CODE TO PARENT_PROFILES
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.parent_profiles
  ADD COLUMN IF NOT EXISTS referral_code TEXT;

COMMENT ON COLUMN public.parent_profiles.referral_code
IS 'Unique immutable referral code (CT + 12 uppercase hex chars). Database-generated. Parents cannot choose or modify.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. BACKFILL EXISTING PARENT PROFILES
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_row RECORD;
  v_code TEXT;
BEGIN
  FOR v_row IN SELECT id FROM public.parent_profiles WHERE referral_code IS NULL LOOP
    v_code := public.generate_parent_referral_code();
    UPDATE public.parent_profiles SET referral_code = v_code WHERE id = v_row.id;
  END LOOP;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. NOT NULL, UNIQUE, AND FORMAT CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.parent_profiles
  ALTER COLUMN referral_code SET NOT NULL;

ALTER TABLE public.parent_profiles
  ADD CONSTRAINT parent_profiles_referral_code_unique UNIQUE (referral_code);

ALTER TABLE public.parent_profiles
  ADD CONSTRAINT parent_profiles_referral_code_check
    CHECK (referral_code ~ '^CT[0-9A-F]{12}$');

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. BEFORE INSERT TRIGGER — assign referral code
-- ═════════════════════════════════════════════════════════════════════════════
-- Automatically generates a referral code for every new parent profile.
-- Ignores any client-supplied referral_code value.

CREATE OR REPLACE FUNCTION public.assign_parent_referral_code()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.referral_code := public.generate_parent_referral_code();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.assign_parent_referral_code()
IS 'BEFORE INSERT trigger on parent_profiles — generates and assigns a referral code, ignoring any client-supplied value.';

DROP TRIGGER IF EXISTS assign_parent_referral_code ON public.parent_profiles;
CREATE TRIGGER assign_parent_referral_code
  BEFORE INSERT ON public.parent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_parent_referral_code();

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. BEFORE UPDATE TRIGGER — prevent referral code changes
-- ═════════════════════════════════════════════════════════════════════════════
-- Blocks any attempt to change the referral_code column after creation.
-- Allows no-op updates (NEW IS NOT DISTINCT FROM OLD).

CREATE OR REPLACE FUNCTION public.prevent_parent_referral_code_change()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    RAISE EXCEPTION 'ERR_PARENT_REFERRAL_CODE_IMMUTABLE'
      USING HINT = 'Referral code is permanent and cannot be changed.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.prevent_parent_referral_code_change()
IS 'BEFORE UPDATE trigger on parent_profiles — prevents changes to the referral_code column.';

DROP TRIGGER IF EXISTS prevent_parent_referral_code_change ON public.parent_profiles;
CREATE TRIGGER prevent_parent_referral_code_change
  BEFORE UPDATE OF referral_code ON public.parent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_parent_referral_code_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. REFERRAL PROGRAM SETTINGS
-- ═════════════════════════════════════════════════════════════════════════════
-- Singleton row (id = 1) controlling the referral program globally.
-- reward_basis_points: reward amount in basis points (1 bp = 0.01%).
-- Only row with id=1 is allowed.

CREATE TABLE IF NOT EXISTS public.referral_program_settings (
  id                  SMALLINT PRIMARY KEY CHECK (id = 1),
  is_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  reward_basis_points INTEGER NOT NULL DEFAULT 1500 CHECK (reward_basis_points >= 0 AND reward_basis_points <= 10000),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.referral_program_settings
IS 'Singleton row (id=1) controlling the global referral program.';

COMMENT ON COLUMN public.referral_program_settings.reward_basis_points
IS 'Reward amount in basis points (1 bp = 0.01%). 1500 = 15%.';

-- Auto-maintain updated_at
DROP TRIGGER IF EXISTS referral_program_settings_set_updated_at ON public.referral_program_settings;
CREATE TRIGGER referral_program_settings_set_updated_at
  BEFORE UPDATE ON public.referral_program_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Seed the singleton row
INSERT INTO public.referral_program_settings (id, is_enabled, reward_basis_points)
VALUES (1, TRUE, 1500)
ON CONFLICT (id) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. REFERRAL RELATIONSHIPS
-- ═════════════════════════════════════════════════════════════════════════════
-- Tracks which parent referred which other parent.
-- FK ON DELETE SET NULL preserves the relationship row on account deletion.
-- One relationship per non-null referred_parent_id.
-- Self-referral is forbidden.

CREATE TABLE IF NOT EXISTS public.referral_relationships (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referred_parent_id    UUID REFERENCES public.parent_profiles(id) ON DELETE SET NULL,
  referrer_parent_id    UUID REFERENCES public.parent_profiles(id) ON DELETE SET NULL,
  referral_code_snapshot TEXT NOT NULL CHECK (referral_code_snapshot ~ '^CT[0-9A-F]{12}$'),
  binding_source        TEXT NOT NULL DEFAULT 'manual' CHECK (binding_source IN ('manual', 'signup_link')),
  bound_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.referral_relationships
IS 'Records which parent referred which other parent. One binding per referred parent. Self-referral forbidden.';

COMMENT ON COLUMN public.referral_relationships.referral_code_snapshot
IS 'Snapshot of the referrer referral_code at binding time. Immutable copy, not a live FK.';

-- Prevent self-referral (allows both NULL when accounts are deleted)
ALTER TABLE public.referral_relationships
  ADD CONSTRAINT referral_relationships_no_self_referral
    CHECK (referred_parent_id IS NULL OR referrer_parent_id IS NULL OR referred_parent_id <> referrer_parent_id);

-- One relationship per referred parent (when not null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_relationships_referred
  ON public.referral_relationships (referred_parent_id)
  WHERE referred_parent_id IS NOT NULL;

-- Index for lookups by referrer
CREATE INDEX IF NOT EXISTS idx_referral_relationships_referrer
  ON public.referral_relationships (referrer_parent_id);

-- Index for chronological queries
CREATE INDEX IF NOT EXISTS idx_referral_relationships_bound_at
  ON public.referral_relationships (bound_at DESC);

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. FUNCTION EXECUTION GRANTS
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.generate_parent_referral_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_parent_referral_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_parent_referral_code_change() FROM PUBLIC;

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. ROW-LEVEL SECURITY — referral_program_settings
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.referral_program_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.referral_program_settings FROM anon;
REVOKE ALL ON public.referral_program_settings FROM authenticated;

GRANT SELECT ON public.referral_program_settings TO authenticated;

-- Authenticated users may read the single settings row
CREATE POLICY referral_program_settings_select_all ON public.referral_program_settings
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT, UPDATE, or DELETE policies — settings changes are admin-only
-- through database migrations or future admin RPC.

-- ═════════════════════════════════════════════════════════════════════════════
-- 11. ROW-LEVEL SECURITY — referral_relationships
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.referral_relationships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.referral_relationships FROM anon;
REVOKE ALL ON public.referral_relationships FROM authenticated;

GRANT SELECT ON public.referral_relationships TO authenticated;

-- Parent: SELECT only their own incoming relationship (they were referred)
CREATE POLICY referral_relationships_select_own ON public.referral_relationships
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.parent_profiles
      WHERE parent_profiles.id = referral_relationships.referred_parent_id
        AND parent_profiles.user_id = auth.uid()
    )
  );

-- Admin / super_admin: SELECT all relationships
CREATE POLICY referral_relationships_select_admin ON public.referral_relationships
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- No INSERT, UPDATE, or DELETE policies — relationships are created
-- exclusively through a future trusted RPC (referral_bind_parent).

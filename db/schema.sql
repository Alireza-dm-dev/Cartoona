-- =============================================================================
-- Cartoona Database Schema — Draft v0
-- =============================================================================
-- This is the initial schema draft for the Cartoona platform.
-- It defines the core data model: users, profiles, orders, content, and audit.
-- See docs/AUTH_RLS_PLAN.md for the full auth, role, and RLS architecture plan.
--
-- TODO:
--  - Add RLS policies for each table (parent sees own data, admin sees all).
--  - Add indexes on foreign keys, status columns, and created_at for queries.
--  - Create storage buckets: parent-uploads, generated-media.
--  - Add triggers for updated_at timestamps.
--  - Add candy transaction safety (check balances before spend, prevent negative).
--  - Implement soft delete retention policy.
-- =============================================================================

-- ============================================================
-- USERS
-- ============================================================
-- Extends Supabase auth.users with application-level role.
-- A trigger on auth.users after insert creates a matching public.users row.
-- TODO: Add RLS — users can read/update own record; admin/super_admin can read all.
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'parent' CHECK (role IN ('parent', 'admin', 'super_admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

-- Automatically creates a public.users row when a new auth.users row is created.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, 'parent');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- PARENT PROFILES
-- ============================================================
-- Each parent user has one profile with consent tracking.
-- TODO: Add RLS — parent can read/update own profile; admin/super_admin can read all.
CREATE TABLE IF NOT EXISTS public.parent_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  consent_granted   BOOLEAN NOT NULL DEFAULT FALSE,
  consent_granted_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CHILD PROFILES
-- ============================================================
-- Optional profiles created by parents for personalization.
-- Children do NOT have independent accounts.
-- TODO: Add RLS — parent can CRUD own children; admin can read all.
CREATE TABLE IF NOT EXISTS public.child_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id             UUID NOT NULL REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  birth_year            INTEGER,
  favorite_character_id UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CHARACTERS
-- ============================================================
-- Original character universe managed by admins.
-- TODO: Add RLS — public read for active characters; admin write.
CREATE TABLE IF NOT EXISTS public.characters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  image_url   TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ORDERS
-- ============================================================
-- Core request table — every creation starts here.
-- TODO: Add RLS — parent can CRUD own orders; admin can read/update all.
CREATE TABLE IF NOT EXISTS public.orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id         UUID NOT NULL REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('image', 'video', 'drawing_animation')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_payment', 'pending_review', 'in_progress', 'ready', 'delivered', 'rejected', 'cancelled')),
  title             TEXT NOT NULL,
  description       TEXT,
  character_id      UUID REFERENCES public.characters(id),
  candy_cost        INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'passed', 'flagged', 'blocked', 'manual_review')),
  assigned_admin_id UUID REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MEDIA ASSETS
-- ============================================================
-- Uploaded and generated media linked to orders.
-- TODO: Add RLS — parent can read own orders' assets; admin can read all.
CREATE TABLE IF NOT EXISTS public.media_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('upload', 'generated')),
  file_url          TEXT NOT NULL,
  mime_type         TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'passed', 'flagged', 'blocked', 'manual_review')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CANDY WALLETS
-- ============================================================
-- One wallet per parent for tracking candy balance.
-- TODO: Add RLS — parent can read own wallet; admin can read all.
CREATE TABLE IF NOT EXISTS public.candy_wallets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL UNIQUE REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CANDY TRANSACTIONS
-- ============================================================
-- Immutable ledger of all candy movements.
-- TODO: Add RLS — parent can read own transactions; admin can read all.
-- TODO: Add trigger to prevent balance from going negative.
-- TODO: Consider a stored procedure for atomic spend operations.
CREATE TABLE IF NOT EXISTS public.candy_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES public.candy_wallets(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('purchase', 'spend', 'refund', 'grant')),
  reference_type  TEXT,
  reference_id    TEXT,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- VIDEO REQUESTS
-- ============================================================
-- Extended details for video-type orders.
-- TODO: Add RLS — parent can read own; admin can read/update all.
CREATE TABLE IF NOT EXISTS public.video_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  script          TEXT,
  duration_seconds INTEGER,
  style           TEXT,
  output_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- DRAWING ANIMATION REQUESTS
-- ============================================================
-- Extended details for drawing_animation-type orders.
-- TODO: Add RLS — parent can read own; admin can read/update all.
CREATE TABLE IF NOT EXISTS public.drawing_animation_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  upload_url      TEXT NOT NULL,
  animation_style TEXT,
  output_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MODERATION LOGS
-- ============================================================
-- Tracks moderation actions on all content types.
-- TODO: Add RLS — admin write/read only.
CREATE TABLE IF NOT EXISTS public.moderation_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   TEXT NOT NULL,
  target_id     UUID NOT NULL,
  action        TEXT NOT NULL,
  moderator_id  UUID REFERENCES public.users(id),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
-- Immutable audit trail for sensitive operations.
-- TODO: Add RLS — admin write/read only.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   UUID NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

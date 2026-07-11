-- Migration: 00004_rls_policies_users_profiles_characters
-- Enables RLS and creates policies for the three foundational tables.
-- All writes to these tables are service-role only — direct INSERT, UPDATE role,
-- and DELETE are not granted to any client role.
-- Parent consent fields (consent_granted, consent_granted_at) are not
-- client-editable until the consent flow is implemented.
-- Character writes are service-role only; the marketing page currently
-- sources data from config/characters.ts, not Supabase.
-- Requires: 00001 (schema), 00002 (helper functions), 00003 (ownership indexes)
-- Depends on: public.is_admin_or_super_admin() from migration 00002

-- ════════════════════════════════════════════════════════════════
-- 1. Enable Row-Level Security
-- ════════════════════════════════════════════════════════════════
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════
-- 2. Revoke default broad grants — anon and authenticated roles
--    get no blanket table permissions on these three tables.
-- ════════════════════════════════════════════════════════════════
REVOKE ALL ON public.users FROM anon, authenticated;
REVOKE ALL ON public.parent_profiles FROM anon, authenticated;
REVOKE ALL ON public.characters FROM anon, authenticated;

-- ════════════════════════════════════════════════════════════════
-- 3. Grant minimum permissions needed by each role.
--    anon gets nothing — no anonymous database access is required yet.
--    authenticated gets SELECT on all three tables and column-limited
--    UPDATE on parent_profiles.full_name.
-- ════════════════════════════════════════════════════════════════
GRANT SELECT ON public.users TO authenticated;
GRANT SELECT ON public.parent_profiles TO authenticated;
GRANT UPDATE (full_name) ON public.parent_profiles TO authenticated;
GRANT SELECT ON public.characters TO authenticated;

-- ════════════════════════════════════════════════════════════════
-- 4. public.users policies
--    Parents see only their own row. Admins/super_admins see all rows.
--    No INSERT/UPDATE/DELETE policies exist — user creation is handled
--    by the trigger on auth.users (see migration 00001), and role/email
--    changes are service-role only to prevent self-escalation and
--    data divergence from auth.users.
-- ════════════════════════════════════════════════════════════════
CREATE POLICY users_select_own ON public.users
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY users_select_admin ON public.users
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- ════════════════════════════════════════════════════════════════
-- 5. public.parent_profiles policies
--    Parents see and may update only their own profile.
--    The WITH CHECK on the UPDATE policy prevents relinking the
--    profile to a different user. The column-level grant limits
--    updates to full_name only — consent fields remain server-side
--    until the consent flow is implemented.
--    No INSERT/DELETE policies — profile creation is server-side on signup.
-- ════════════════════════════════════════════════════════════════
CREATE POLICY parent_profiles_select_own ON public.parent_profiles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY parent_profiles_select_admin ON public.parent_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

CREATE POLICY parent_profiles_update_own ON public.parent_profiles
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ════════════════════════════════════════════════════════════════
-- 6. public.characters policies
--    Authenticated users see only active characters. Admins/super_admins
--    see all characters (including inactive).
--    No anon policy — the marketing page uses config/characters.ts.
--    No INSERT/UPDATE/DELETE policies — all character mutations are
--    service-role only via the admin Supabase client.
-- ════════════════════════════════════════════════════════════════
CREATE POLICY characters_select_active ON public.characters
  FOR SELECT
  TO authenticated
  USING (is_active = true);

CREATE POLICY characters_select_admin ON public.characters
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

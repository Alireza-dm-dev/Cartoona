-- Migration: parent_consent_persistence
-- Enables authenticated parents to insert their own profile and update consent
-- fields, supporting the real-time consent flow from /parent-consent page.
--
-- Background:
--   - parent_profiles rows are NOT auto-created by the signup trigger
--     (handle_new_user only inserts public.users).
--   - The signup page stores full_name in auth.users.raw_user_meta_data,
--     accessible server-side via supabase.auth.getUser().
--   - At consent time the parent needs to INSERT their own profile row
--     with user_id=auth.uid() and full_name from metadata, then set
--     consent_granted=true and consent_granted_at=now().
--
-- Changes:
--   1. GRANT INSERT on the subset of columns a parent may set when
--      creating their own profile.
--   2. GRANT UPDATE on consent_granted and consent_granted_at for
--      the existing own-profile UPDATE policy.
--   3. CREATE an INSERT policy that restricts profile creation to
--      the authenticated user's own user_id.
--
-- Preserves:
--   - All existing SELECT/UPDATE policies
--   - Admin SELECT access (parent_profiles_select_admin)
--   - The existing full_name UPDATE grant
--   - full_name NOT NULL constraint (validated server-side)
--   - Anon has no access

-- ════════════════════════════════════════════════════════════════
-- 1. Column-level grants
-- ════════════════════════════════════════════════════════════════

-- Parents need INSERT on their own profile at consent time.
-- user_id, full_name, consent_granted, consent_granted_at are the
-- columns the server writes when creating the row.
GRANT INSERT (user_id, full_name, consent_granted, consent_granted_at)
  ON public.parent_profiles TO authenticated;

-- Extend the existing UPDATE grant (currently full_name only) so the
-- parent can also record consent.
GRANT UPDATE (consent_granted, consent_granted_at)
  ON public.parent_profiles TO authenticated;

-- ════════════════════════════════════════════════════════════════
-- 2. INSERT policy for own-profile creation
-- ════════════════════════════════════════════════════════════════
-- Allows an authenticated parent to create exactly one profile row
-- linked to their own auth.uid(). The UNIQUE constraint on user_id
-- enforces one-profile-per-parent at the database level.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'parent_profiles'
    AND policyname = 'parent_profiles_insert_own'
  ) THEN
    CREATE POLICY parent_profiles_insert_own ON public.parent_profiles
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END;
$$;

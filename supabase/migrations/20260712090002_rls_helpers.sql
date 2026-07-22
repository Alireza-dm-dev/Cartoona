-- Migration: 00002_rls_helpers
-- Creates safe RLS helper functions using SECURITY DEFINER to prevent recursion
-- when policies on public.users query public.users for role checks.
-- Must be applied after migration 00001 and before any RLS policies.

-- 1. Returns true when the current user has admin or super_admin role.
--    SECURITY DEFINER ensures the internal query to public.users does not
--    trigger RLS recursion when used in a policy on public.users itself.
CREATE OR REPLACE FUNCTION public.is_admin_or_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin', 'super_admin')
  );
$$;

-- 2. Returns true only when the current user has super_admin role.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$$;

-- 3. Returns the parent_profiles.id for the current authenticated user,
--    or NULL when no profile exists. Used for parent-ownership policies.
CREATE OR REPLACE FUNCTION public.current_parent_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM public.parent_profiles WHERE user_id = auth.uid()
$$;

-- Restrict execution: only authenticated database roles may call these functions.
REVOKE ALL ON FUNCTION public.is_admin_or_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_parent_profile_id() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.is_admin_or_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_parent_profile_id() TO authenticated;

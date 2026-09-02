-- =============================================================================
-- Cartoona — Private Media Storage Foundation
-- =============================================================================
-- Creates two private Supabase Storage buckets for the parent-to-admin
-- request workflow, along with narrowly scoped RLS policies.
--
-- Buckets:
--   parent-uploads   — Parents upload source media (photos, drawings).
--                      Private, parent-own access; admin SELECT only.
--   generated-media  — Admins deliver completed results to parents.
--                      Private, admin CRUD; parent own SELECT only.
--
-- See also:
--   docs/AUTH_RLS_PLAN.md for the overall auth/storage architecture.
-- =============================================================================

-- ════════════════════════════════════════════════════════════════
-- 1. PARENT ROLE HELPER
-- ════════════════════════════════════════════════════════════════
-- Returns true when the current user's application role is 'parent'.
-- Uses SECURITY DEFINER (matching public.is_admin()) to avoid RLS
-- recursion when called from storage.objects policies.
CREATE OR REPLACE FUNCTION public.is_parent()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role = 'parent'
  );
$$;

-- ════════════════════════════════════════════════════════════════
-- 2. BUCKET: parent-uploads
-- ════════════════════════════════════════════════════════════════
-- Private bucket for parent-submitted source images.
-- Path convention: <parent-auth-user-id>/<upload-id>/<filename>
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'parent-uploads',
  'parent-uploads',
  FALSE,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ════════════════════════════════════════════════════════════════
-- 3. BUCKET: generated-media
-- ════════════════════════════════════════════════════════════════
-- Private bucket for admin-delivered completed results.
-- Path convention: <parent-auth-user-id>/<order-id>/<filename>
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'generated-media',
  'generated-media',
  FALSE,
  104857600,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ════════════════════════════════════════════════════════════════
-- 4. EXECUTION GRANTS — is_parent()
-- ════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.is_parent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_parent() TO authenticated;

-- ════════════════════════════════════════════════════════════════
-- 5. STORAGE POLICIES — parent-uploads
-- ════════════════════════════════════════════════════════════════

-- Parent own INSERT — only files under the parent's own user-ID folder
CREATE POLICY parent_uploads_insert_own ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'parent-uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_parent()
  );

-- Parent own SELECT
CREATE POLICY parent_uploads_select_own ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'parent-uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_parent()
  );

-- Parent own DELETE (for rollback of failed uploads)
CREATE POLICY parent_uploads_delete_own ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'parent-uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_parent()
  );

-- Admin SELECT — admins can review all parent uploads
CREATE POLICY parent_uploads_select_admin ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'parent-uploads'
    AND public.is_admin()
  );

-- ════════════════════════════════════════════════════════════════
-- 6. STORAGE POLICIES — generated-media
-- ════════════════════════════════════════════════════════════════

-- Admin INSERT
CREATE POLICY generated_media_insert_admin ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'generated-media'
    AND public.is_admin()
  );

-- Admin SELECT
CREATE POLICY generated_media_select_admin ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'generated-media'
    AND public.is_admin()
  );

-- Admin UPDATE
CREATE POLICY generated_media_update_admin ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'generated-media'
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id = 'generated-media'
    AND public.is_admin()
  );

-- Admin DELETE
CREATE POLICY generated_media_delete_admin ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'generated-media'
    AND public.is_admin()
  );

-- Parent own SELECT — only completed media under the parent's own folder
CREATE POLICY generated_media_select_parent ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'generated-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_parent()
  );

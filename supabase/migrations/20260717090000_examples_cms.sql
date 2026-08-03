-- =============================================================================
-- Cartoona — Examples CMS Foundation
-- =============================================================================
-- Adds the examples table, RLS policies, storage bucket, and a reusable
-- set_updated_at() helper that other tables can adopt later.
-- =============================================================================

-- ============================================================
-- UPDATED_AT TRIGGER HELPER
-- ============================================================
-- Reusable function so every table with an updated_at column can
-- get auto-timestamping without repeating the logic.
-- TODO: Apply to existing tables (users, parent_profiles, etc.).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ADMIN ROLE HELPER
-- ============================================================
-- Safe RLS helper so we can write policies like USING (is_admin()).
-- Checks the public.users table which mirrors auth.users.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
    AND role IN ('admin', 'super_admin')
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- EXAMPLES TABLE
-- ============================================================
-- Curated examples shown on the public /showcase page.
-- Admins manage these through the CMS admin interface.
CREATE TABLE IF NOT EXISTS public.examples (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('video', 'drawing', 'story')),
  title            TEXT NOT NULL,
  description      TEXT,
  character_id     UUID REFERENCES public.characters(id) ON DELETE SET NULL,
  media_url        TEXT NOT NULL,
  thumbnail_url    TEXT,
  is_published     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.examples IS 'Curated examples for the public showcase page. Managed by admins.';
COMMENT ON COLUMN public.examples.kind IS 'Example category: video, drawing, or story.';
COMMENT ON COLUMN public.examples.character_id IS 'Optional character featured in this example.';
COMMENT ON COLUMN public.examples.media_url IS 'File URL in the example-media storage bucket.';
COMMENT ON COLUMN public.examples.is_published IS 'Controls visibility on the public showcase.';
COMMENT ON COLUMN public.examples.sort_order IS 'Ascending sort position in the showcase grid.';

-- Auto-maintain updated_at on row changes
DROP TRIGGER IF EXISTS examples_set_updated_at ON public.examples;
CREATE TRIGGER examples_set_updated_at
  BEFORE UPDATE ON public.examples
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- RLS — EXAMPLES
-- ============================================================
-- Published examples are world-readable (public showcase).
-- Admins have full CRUD for managing the gallery.
ALTER TABLE public.examples ENABLE ROW LEVEL SECURITY;

-- Public read — anyone can see published examples
CREATE POLICY "examples_select_published" ON public.examples
  FOR SELECT
  USING (is_published = TRUE);

-- Admin read — admins see everything including drafts
CREATE POLICY "examples_select_admin" ON public.examples
  FOR SELECT
  USING (is_admin());

-- Admin insert
CREATE POLICY "examples_insert_admin" ON public.examples
  FOR INSERT
  WITH CHECK (is_admin());

-- Admin update
CREATE POLICY "examples_update_admin" ON public.examples
  FOR UPDATE
  USING (is_admin())
  WITH CHECK (is_admin());

-- Admin delete
CREATE POLICY "examples_delete_admin" ON public.examples
  FOR DELETE
  USING (is_admin());

-- ============================================================
-- STORAGE BUCKET — EXAMPLE MEDIA
-- ============================================================
-- Public bucket so the showcase can serve media without signed URLs.
-- File limit matches the global default (50 MiB).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'example-media',
  'example-media',
  TRUE,
  52428800,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Allow public read
CREATE POLICY "example_media_select_public" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'example-media');

-- Admin write
CREATE POLICY "example_media_insert_admin" ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'example-media' AND is_admin());

-- Admin update
CREATE POLICY "example_media_update_admin" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'example-media' AND is_admin())
  WITH CHECK (bucket_id = 'example-media' AND is_admin());

-- Admin delete
CREATE POLICY "example_media_delete_admin" ON storage.objects
  FOR DELETE
  USING (bucket_id = 'example-media' AND is_admin());

-- ============================================================
-- INDEXES
-- ============================================================
-- Composite index for the most common query: published examples sorted.
-- Also index kind for filtered browsing (e.g. "show me only videos").
CREATE INDEX IF NOT EXISTS idx_examples_published_sort
  ON public.examples (is_published, sort_order ASC)
  WHERE is_published = TRUE;

CREATE INDEX IF NOT EXISTS idx_examples_kind
  ON public.examples (kind);

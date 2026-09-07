-- =============================================================================
-- Cartoona — Homepage CMS Media Manager (Phase 3)
-- =============================================================================
-- Adds the server-side media plane for the homepage editor:
--
--   storage bucket    homepage-media (public read, NO browser writes)
--   table             public.homepage_hero_layout (TV rect singleton)
--   RPC               public.record_homepage_media_replacement_trusted(...)
--                     ONE atomic transaction for a full replacement
--   RPC               public.update_homepage_hero_layout_trusted(...)
--                     standalone calibration edit (no media change)
--   RPC               public.delete_homepage_media_trusted(...)
--                     revert a slot to local-asset fallback
--
-- Atomicity design (Correction 1): the storage upload itself cannot join the
-- Postgres transaction, but every CMS metadata mutation after upload commits
-- in ONE trusted RPC call. The API flow is therefore:
--
--   validate request -> upload new object -> call ONE atomic RPC ->
--   RPC failure  => delete new object best-effort, previous DB state intact
--   RPC success  => delete superseded old objects best-effort
--
-- There is deliberately NO multi-RPC hero path and NO compensating DB
-- rollback: any DB failure rolls the whole transaction back automatically.
--
-- DELETE design (Correction 2): homepage_media_assets grants nobody any
-- write, so the DELETE API cannot mutate the table directly. It calls
-- delete_homepage_media_trusted, which deletes the row and returns the
-- previous storage metadata for best-effort object cleanup. The storage
-- object is NEVER deleted before the metadata removal succeeds.
--
-- Boundary: metadata only (slot keys, MIME, sizes, dimensions, ONE
-- normalized TV rect). No CSS, no pixels-as-authoritative, no executable
-- content. Deep file validation (magic bytes, dimension probing, per-slot
-- size caps) lives in the application (lib/admin/homepage/media-validation.ts)
-- before any RPC is called; the RPCs re-check allowlists, ranges and roles.
--
-- Scope note: touches ONLY the objects above. No changes to prior
-- migrations' objects, no business tables, no seeds into business data. The
-- hero_layout seed is configuration geometry transcribed from Hero.tsx.
-- Public homepage rendering is unchanged in Phase 3 (wiring is Phase 4).
-- =============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. STORAGE BUCKET — homepage-media
-- ═════════════════════════════════════════════════════════════════════════════
-- Public read (marketing assets, same convention as example-media). The
-- bucket-level file_size_limit is the coarse ceiling; stricter per-slot caps
-- are enforced by the API. MIME array mirrors
-- HOMEPAGE_MEDIA_MIME_ALLOWLIST. There are deliberately NO INSERT / UPDATE /
-- DELETE storage policies: every upload and removal goes through the
-- service-role client inside the admin API routes, so a browser — even an
-- admin's — cannot write to this bucket directly.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'homepage-media',
  'homepage-media',
  TRUE,
  52428800,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']::text[]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "homepage_media_select_public" ON storage.objects;
CREATE POLICY "homepage_media_select_public" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'homepage-media');


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. HERO LAYOUT — normalized TV rect singleton
-- ═════════════════════════════════════════════════════════════════════════════
-- The TV screen position as FRACTIONS of the hero background artwork
-- (0.0–1.0). Pixels are never authoritative. Zoom, focus, crop and story
-- mechanics stay in code. Readable by anyone (public marketing geometry),
-- writable by nobody except the trusted RPC below.

CREATE TABLE IF NOT EXISTS public.homepage_hero_layout (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key       TEXT NOT NULL UNIQUE DEFAULT 'hero'
                        CHECK (singleton_key = 'hero'),
  tv_rect             JSONB NOT NULL
                        CHECK (jsonb_typeof(tv_rect) = 'object'),
  revision            INTEGER NOT NULL DEFAULT 1
                        CHECK (revision >= 1),
  updated_by_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.homepage_hero_layout IS
  'Normalized TV screen rect for the hero background artwork. Exactly one row (singleton_key = ''hero''). Fractions only; zoom/focus/crop stay in code. Not read by the public hero until Phase 4.';
COMMENT ON COLUMN public.homepage_hero_layout.tv_rect IS
  'JSON object {x, y, width, height}, each 0.0–1.0, x+width <= 1, y+height <= 1. Validated by the application and re-checked by the trusted RPC.';
COMMENT ON COLUMN public.homepage_hero_layout.revision IS
  'Monotonic counter for optimistic concurrency on calibration edits.';

DROP TRIGGER IF EXISTS homepage_hero_layout_set_updated_at ON public.homepage_hero_layout;
CREATE TRIGGER homepage_hero_layout_set_updated_at
  BEFORE UPDATE ON public.homepage_hero_layout
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.homepage_hero_layout ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "homepage_hero_layout_select_public" ON public.homepage_hero_layout;
CREATE POLICY "homepage_hero_layout_select_public" ON public.homepage_hero_layout
  FOR SELECT
  USING (TRUE);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.homepage_hero_layout FROM anon, authenticated;
GRANT SELECT ON public.homepage_hero_layout TO anon, authenticated;

-- Seed: transcription of TV_SCREEN_RECT in components/marketing/Hero.tsx
-- (cutout measured x 215..400, y 218..364 of 2048x1529). Idempotent: never
-- overwrites a calibrated rect an admin has since saved.
INSERT INTO public.homepage_hero_layout (singleton_key, tv_rect, revision)
VALUES (
  'hero',
  '{"x": 0.105, "y": 0.1426, "width": 0.0908, "height": 0.0961}'::jsonb,
  1
)
ON CONFLICT (singleton_key) DO NOTHING;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. ATOMIC REPLACEMENT RPC — the ONLY media write path
-- ═════════════════════════════════════════════════════════════════════════════
-- Commits a complete replacement in ONE database transaction:
--   primary media upsert
--   + optional sections.background upsert (apply_to_sections, same object)
--   + optional hero layout update (supplied rect, revision-checked)
--
-- Any failure rolls everything back; the API then deletes the newly uploaded
-- object and the previous DB state is untouched.

CREATE OR REPLACE FUNCTION public.record_homepage_media_replacement_trusted(
  p_admin_user_id            UUID,
  p_primary_slot             TEXT,
  p_media_type               TEXT,
  p_storage_path             TEXT,
  p_mime_type                TEXT,
  p_byte_size                BIGINT,
  p_width                    INTEGER,
  p_height                   INTEGER,
  p_duration_seconds         NUMERIC,
  p_hero_tv_rect             JSONB DEFAULT NULL,
  p_expected_layout_revision INTEGER DEFAULT NULL,
  p_apply_to_sections        BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
  v_current_layout_revision INTEGER;
  v_new_layout_revision INTEGER;
  v_rx FLOAT; v_ry FLOAT; v_rw FLOAT; v_rh FLOAT;
  v_primary public.homepage_media_assets%ROWTYPE;
  v_sections public.homepage_media_assets%ROWTYPE;
BEGIN
  -- 1. Admin role check (defense in depth; callable only by service_role anyway).
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_media_forbidden';
  END IF;

  -- 2. Slot allowlist (mirrors lib/homepage/media-slots.ts + table CHECK).
  IF p_primary_slot NOT IN (
    'hero.background', 'hero.tv_video', 'sections.background',
    'build_options.card_image', 'build_options.card_video',
    'build_options.card_animation', 'safety.image'
  ) THEN
    RAISE EXCEPTION 'homepage_media_invalid_slot';
  END IF;

  -- 3. Slot/media-type compatibility.
  IF p_primary_slot IN ('hero.background', 'sections.background',
                        'build_options.card_image', 'safety.image')
     AND p_media_type <> 'image' THEN
    RAISE EXCEPTION 'homepage_media_type_mismatch';
  END IF;
  IF p_primary_slot IN ('hero.tv_video', 'build_options.card_video',
                        'build_options.card_animation')
     AND p_media_type <> 'video' THEN
    RAISE EXCEPTION 'homepage_media_type_mismatch';
  END IF;

  -- 4. Storage path safety (key only: no scheme, no protocol-relative, no traversal).
  IF p_storage_path IS NULL OR char_length(trim(p_storage_path)) = 0
     OR p_storage_path ~ '^[A-Za-z][A-Za-z0-9+.-]*:'
     OR p_storage_path LIKE '//%'
     OR p_storage_path LIKE '%..%' THEN
    RAISE EXCEPTION 'homepage_media_invalid_path';
  END IF;

  -- 5. MIME allowlist matched to the declared type.
  IF p_media_type = 'image'
     AND p_mime_type NOT IN ('image/png', 'image/jpeg', 'image/webp') THEN
    RAISE EXCEPTION 'homepage_media_invalid_mime';
  END IF;
  IF p_media_type = 'video'
     AND p_mime_type NOT IN ('video/mp4', 'video/webm') THEN
    RAISE EXCEPTION 'homepage_media_invalid_mime';
  END IF;

  -- 6. Byte size sanity (bucket ceiling; stricter per-slot caps live in the API).
  IF p_byte_size IS NULL OR p_byte_size <= 0 OR p_byte_size > 52428800 THEN
    RAISE EXCEPTION 'homepage_media_invalid_size';
  END IF;

  -- 7. Geometry block. hero.background replacement REQUIRES a valid rect:
  --    new artwork must never silently inherit old TV placement.
  IF p_primary_slot = 'hero.background' THEN
    IF p_hero_tv_rect IS NULL OR jsonb_typeof(p_hero_tv_rect) <> 'object' THEN
      RAISE EXCEPTION 'homepage_media_geometry_required';
    END IF;
    BEGIN
      v_rx := (p_hero_tv_rect->>'x')::float;
      v_ry := (p_hero_tv_rect->>'y')::float;
      v_rw := (p_hero_tv_rect->>'width')::float;
      v_rh := (p_hero_tv_rect->>'height')::float;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'homepage_media_layout_invalid';
    END;
    IF v_rx IS NULL OR v_ry IS NULL OR v_rw IS NULL OR v_rh IS NULL
       OR v_rx != v_rx OR v_ry != v_ry OR v_rw != v_rw OR v_rh != v_rh
       OR v_rx < 0 OR v_rx > 1 OR v_ry < 0 OR v_ry > 1
       OR v_rw <= 0 OR v_rh <= 0
       OR v_rx + v_rw > 1 OR v_ry + v_rh > 1 THEN
      RAISE EXCEPTION 'homepage_media_layout_invalid';
    END IF;
    IF p_expected_layout_revision IS NULL THEN
      RAISE EXCEPTION 'homepage_media_layout_conflict';
    END IF;
  ELSIF p_hero_tv_rect IS NOT NULL THEN
    -- Geometry is only ever accepted alongside a hero.background replacement.
    RAISE EXCEPTION 'homepage_media_invalid';
  END IF;

  IF p_apply_to_sections AND p_primary_slot <> 'hero.background' THEN
    RAISE EXCEPTION 'homepage_media_invalid';
  END IF;

  -- 8. Lock the layout row FIRST (fixed order: layout, then media rows),
  --    so concurrent replacements serialize identically and cannot deadlock.
  IF p_primary_slot = 'hero.background' THEN
    SELECT public.homepage_hero_layout.revision
    INTO v_current_layout_revision
    FROM public.homepage_hero_layout
    WHERE public.homepage_hero_layout.singleton_key = 'hero'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'homepage_media_layout_missing';
    END IF;
    IF v_current_layout_revision <> p_expected_layout_revision THEN
      RAISE EXCEPTION 'homepage_media_layout_conflict';
    END IF;
    v_new_layout_revision := v_current_layout_revision + 1;
  END IF;

  -- 9. Upsert the primary media row.
  INSERT INTO public.homepage_media_assets AS m
    (slot_key, media_type, storage_path, mime_type, byte_size,
     width, height, duration_seconds, updated_by_user_id)
  VALUES
    (p_primary_slot, p_media_type, p_storage_path, p_mime_type, p_byte_size,
     p_width, p_height, p_duration_seconds, p_admin_user_id)
  ON CONFLICT (slot_key) DO UPDATE SET
    media_type = EXCLUDED.media_type,
    storage_path = EXCLUDED.storage_path,
    mime_type = EXCLUDED.mime_type,
    byte_size = EXCLUDED.byte_size,
    width = EXCLUDED.width,
    height = EXCLUDED.height,
    duration_seconds = EXCLUDED.duration_seconds,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = now()
  RETURNING * INTO v_primary;

  -- 10. Shared-background commit: SAME transaction, SAME object.
  IF p_apply_to_sections THEN
    INSERT INTO public.homepage_media_assets AS m
      (slot_key, media_type, storage_path, mime_type, byte_size,
       width, height, duration_seconds, updated_by_user_id)
    VALUES
      ('sections.background', p_media_type, p_storage_path, p_mime_type, p_byte_size,
       p_width, p_height, p_duration_seconds, p_admin_user_id)
    ON CONFLICT (slot_key) DO UPDATE SET
      media_type = EXCLUDED.media_type,
      storage_path = EXCLUDED.storage_path,
      mime_type = EXCLUDED.mime_type,
      byte_size = EXCLUDED.byte_size,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      duration_seconds = EXCLUDED.duration_seconds,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING * INTO v_sections;
  END IF;

  -- 11. Hero layout update in the SAME transaction; revision bumped exactly once.
  IF p_primary_slot = 'hero.background' THEN
    UPDATE public.homepage_hero_layout
    SET tv_rect = jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
        revision = v_new_layout_revision,
        updated_by_user_id = p_admin_user_id,
        updated_at = now()
    WHERE public.homepage_hero_layout.singleton_key = 'hero';
  END IF;

  -- 12. Safe snapshots for the API (storage paths stay server-side; the
  --     serializer strips them before anything reaches the browser).
  RETURN jsonb_build_object(
    'media', jsonb_build_object(
      'slot_key', v_primary.slot_key,
      'media_type', v_primary.media_type,
      'storage_path', v_primary.storage_path,
      'mime_type', v_primary.mime_type,
      'byte_size', v_primary.byte_size,
      'width', v_primary.width,
      'height', v_primary.height,
      'duration_seconds', v_primary.duration_seconds,
      'updated_at', v_primary.updated_at
    ),
    'sections', CASE WHEN p_apply_to_sections THEN jsonb_build_object(
      'slot_key', v_sections.slot_key,
      'storage_path', v_sections.storage_path,
      'mime_type', v_sections.mime_type,
      'byte_size', v_sections.byte_size,
      'width', v_sections.width,
      'height', v_sections.height,
      'updated_at', v_sections.updated_at
    ) ELSE NULL END,
    'layout', CASE WHEN p_primary_slot = 'hero.background' THEN jsonb_build_object(
      'tv_rect', jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
      'revision', v_new_layout_revision
    ) ELSE NULL END
  );
END;
$func$;

COMMENT ON FUNCTION public.record_homepage_media_replacement_trusted(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, NUMERIC, JSONB, INTEGER, BOOLEAN) IS
  'Trusted server-only homepage media replacement. Callable only by service_role. Commits primary media upsert + optional shared sections upsert + optional hero layout update in ONE transaction. Any failure rolls everything back.';

REVOKE ALL ON FUNCTION public.record_homepage_media_replacement_trusted(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, NUMERIC, JSONB, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_homepage_media_replacement_trusted(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, NUMERIC, JSONB, INTEGER, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.record_homepage_media_replacement_trusted(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, NUMERIC, JSONB, INTEGER, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_homepage_media_replacement_trusted(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, INTEGER, INTEGER, NUMERIC, JSONB, INTEGER, BOOLEAN) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. STANDALONE LAYOUT RPC — calibration edit without a media replacement
-- ═════════════════════════════════════════════════════════════════════════════
-- Lets an admin re-calibrate the TV rect against the CURRENT background
-- (e.g. after measuring more carefully) without uploading new media.
-- Atomic by itself; same normalized validation as the replacement RPC.

CREATE OR REPLACE FUNCTION public.update_homepage_hero_layout_trusted(
  p_admin_user_id          UUID,
  p_tv_rect                JSONB,
  p_expected_revision      INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
  v_current_revision INTEGER;
  v_new_revision INTEGER;
  v_rx FLOAT; v_ry FLOAT; v_rw FLOAT; v_rh FLOAT;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_layout_forbidden';
  END IF;

  IF p_tv_rect IS NULL OR jsonb_typeof(p_tv_rect) <> 'object' THEN
    RAISE EXCEPTION 'homepage_layout_invalid';
  END IF;
  BEGIN
    v_rx := (p_tv_rect->>'x')::float;
    v_ry := (p_tv_rect->>'y')::float;
    v_rw := (p_tv_rect->>'width')::float;
    v_rh := (p_tv_rect->>'height')::float;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'homepage_layout_invalid';
  END;
  IF v_rx IS NULL OR v_ry IS NULL OR v_rw IS NULL OR v_rh IS NULL
     OR v_rx != v_rx OR v_ry != v_ry OR v_rw != v_rw OR v_rh != v_rh
     OR v_rx < 0 OR v_rx > 1 OR v_ry < 0 OR v_ry > 1
     OR v_rw <= 0 OR v_rh <= 0
     OR v_rx + v_rw > 1 OR v_ry + v_rh > 1 THEN
    RAISE EXCEPTION 'homepage_layout_invalid';
  END IF;

  SELECT public.homepage_hero_layout.revision
  INTO v_current_revision
  FROM public.homepage_hero_layout
  WHERE public.homepage_hero_layout.singleton_key = 'hero'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'homepage_layout_not_found';
  END IF;
  IF v_current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'homepage_layout_conflict';
  END IF;

  v_new_revision := v_current_revision + 1;

  UPDATE public.homepage_hero_layout
  SET tv_rect = jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
      revision = v_new_revision,
      updated_by_user_id = p_admin_user_id,
      updated_at = now()
  WHERE public.homepage_hero_layout.singleton_key = 'hero';

  RETURN jsonb_build_object(
    'tv_rect', jsonb_build_object('x', v_rx, 'y', v_ry, 'width', v_rw, 'height', v_rh),
    'revision', v_new_revision,
    'updated_at', now()
  );
END;
$func$;

COMMENT ON FUNCTION public.update_homepage_hero_layout_trusted(UUID, JSONB, INTEGER) IS
  'Trusted server-only hero TV rect calibration edit. Callable only by service_role. Revision-checked; revision bumped exactly once.';

REVOKE ALL ON FUNCTION public.update_homepage_hero_layout_trusted(UUID, JSONB, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_homepage_hero_layout_trusted(UUID, JSONB, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.update_homepage_hero_layout_trusted(UUID, JSONB, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_homepage_hero_layout_trusted(UUID, JSONB, INTEGER) TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. TRUSTED DELETE RPC — revert a slot to local-asset fallback
-- ═════════════════════════════════════════════════════════════════════════════
-- homepage_media_assets grants nobody any write, so the DELETE API cannot
-- mutate the table directly. This RPC deletes the row and returns the
-- previous storage metadata for best-effort object cleanup. The API deletes
-- the storage object only AFTER this succeeds — never before.

CREATE OR REPLACE FUNCTION public.delete_homepage_media_trusted(
  p_admin_user_id UUID,
  p_slot_key      TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
  v_old public.homepage_media_assets%ROWTYPE;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_media_forbidden';
  END IF;

  IF p_slot_key NOT IN (
    'hero.background', 'hero.tv_video', 'sections.background',
    'build_options.card_image', 'build_options.card_video',
    'build_options.card_animation', 'safety.image'
  ) THEN
    RAISE EXCEPTION 'homepage_media_invalid_slot';
  END IF;

  SELECT * INTO v_old
  FROM public.homepage_media_assets
  WHERE public.homepage_media_assets.slot_key = p_slot_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'homepage_media_not_found';
  END IF;

  DELETE FROM public.homepage_media_assets
  WHERE public.homepage_media_assets.slot_key = p_slot_key;

  RETURN jsonb_build_object(
    'slot_key', v_old.slot_key,
    'storage_path', v_old.storage_path,
    'mime_type', v_old.mime_type,
    'byte_size', v_old.byte_size
  );
END;
$func$;

COMMENT ON FUNCTION public.delete_homepage_media_trusted(UUID, TEXT) IS
  'Trusted server-only homepage media revert. Callable only by service_role. Deletes the slot metadata row and returns the previous storage metadata for best-effort object cleanup.';

REVOKE ALL ON FUNCTION public.delete_homepage_media_trusted(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_homepage_media_trusted(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.delete_homepage_media_trusted(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_homepage_media_trusted(UUID, TEXT) TO service_role;

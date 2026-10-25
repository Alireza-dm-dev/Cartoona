-- Cartoona plain-PostgreSQL (V0.1.53) - the last business consumers leave the Supabase database
--
-- Referrals, the homepage CMS and the examples CMS are read and written only in
-- this database from now on. Nothing here changes a referral or homepage
-- function: they already exist (0005, bodies untouched, identical to the
-- Supabase ones) and check the caller's role inside PostgreSQL. This migration:
--
--   1. grants EXECUTE on those nine existing trusted functions to cartoona_app
--      (REVOKE ALL FROM PUBLIC first), and SELECT on the four CMS tables the
--      reads need (homepage_content, homepage_media_assets,
--      homepage_hero_layout, examples);
--   2. adds the five narrow examples functions, because the examples CMS wrote
--      its table directly through RLS and there was no trusted function to port.
--      Each one re-checks the admin role in the database, validates its input
--      and touches exactly one table: nothing is granted INSERT/UPDATE/DELETE.
--
-- There is no referral REWARD anywhere in the schema: a referral is a one-time
-- binding plus a program setting (is_enabled, reward_basis_points). No function
-- credits a wallet for a referral, so no ledger effect moves with this change.

CREATE FUNCTION public.create_example_trusted(
    p_admin_user_id uuid, p_id uuid, p_kind text, p_title text, p_badge_label text,
    p_description text, p_media_url text, p_is_published boolean, p_sort_order integer)
    RETURNS SETOF public.examples
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'example_admin_forbidden';
  END IF;
  IF p_id IS NULL OR p_kind NOT IN ('video', 'drawing', 'story')
     OR p_title IS NULL OR pg_catalog.btrim(p_title) = '' OR pg_catalog.char_length(p_title) > 120
     OR p_badge_label IS NULL OR pg_catalog.char_length(p_badge_label) > 40
     OR p_description IS NULL OR pg_catalog.char_length(p_description) > 1000
     OR p_sort_order IS NULL OR p_sort_order < 0 OR p_sort_order > 10000
     OR p_is_published IS NULL THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  -- The object key is server-generated: examples/<this id>/<uuid>.<ext>, never a URL or a traversal.
  IF p_media_url IS NULL OR p_media_url NOT LIKE 'examples/' || p_id::text || '/%'
     OR p_media_url LIKE '%..%' OR p_media_url ~ '^[A-Za-z][A-Za-z0-9+.-]*:' THEN
    RAISE EXCEPTION 'example_admin_invalid_media';
  END IF;

  RETURN QUERY
  INSERT INTO public.examples (id, kind, title, badge_label, description, media_url, is_published, sort_order)
  VALUES (p_id, p_kind, p_title, p_badge_label, p_description, p_media_url, p_is_published, p_sort_order)
  RETURNING *;
END;
$$;

CREATE FUNCTION public.update_example_trusted(p_admin_user_id uuid, p_id uuid, p_fields jsonb)
    RETURNS SETOF public.examples
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_key text;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'example_admin_forbidden';
  END IF;
  IF p_fields IS NULL OR pg_catalog.jsonb_typeof(p_fields) <> 'object' OR p_fields = '{}'::jsonb THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  -- Only these six columns can ever change through this function.
  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(p_fields) LOOP
    IF v_key NOT IN ('title', 'badge_label', 'description', 'kind', 'sort_order', 'is_published') THEN
      RAISE EXCEPTION 'example_admin_invalid';
    END IF;
  END LOOP;
  IF p_fields ? 'kind' AND (pg_catalog.jsonb_typeof(p_fields -> 'kind') <> 'string' OR (p_fields ->> 'kind') NOT IN ('video', 'drawing', 'story')) THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  IF p_fields ? 'title' AND (pg_catalog.jsonb_typeof(p_fields -> 'title') <> 'string' OR pg_catalog.btrim(p_fields ->> 'title') = '' OR pg_catalog.char_length(p_fields ->> 'title') > 120) THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  IF p_fields ? 'badge_label' AND (pg_catalog.jsonb_typeof(p_fields -> 'badge_label') <> 'string' OR pg_catalog.char_length(p_fields ->> 'badge_label') > 40) THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  IF p_fields ? 'description' AND (pg_catalog.jsonb_typeof(p_fields -> 'description') <> 'string' OR pg_catalog.char_length(p_fields ->> 'description') > 1000) THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  IF p_fields ? 'sort_order' AND (pg_catalog.jsonb_typeof(p_fields -> 'sort_order') <> 'number'
        OR (p_fields ->> 'sort_order') !~ '^[0-9]{1,5}$' OR (p_fields ->> 'sort_order')::integer > 10000) THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;
  IF p_fields ? 'is_published' AND pg_catalog.jsonb_typeof(p_fields -> 'is_published') <> 'boolean' THEN
    RAISE EXCEPTION 'example_admin_invalid';
  END IF;

  RETURN QUERY
  UPDATE public.examples e
  SET title        = CASE WHEN p_fields ? 'title'        THEN p_fields ->> 'title'                    ELSE e.title END,
      badge_label  = CASE WHEN p_fields ? 'badge_label'  THEN p_fields ->> 'badge_label'              ELSE e.badge_label END,
      description  = CASE WHEN p_fields ? 'description'  THEN p_fields ->> 'description'              ELSE e.description END,
      kind         = CASE WHEN p_fields ? 'kind'         THEN p_fields ->> 'kind'                     ELSE e.kind END,
      sort_order   = CASE WHEN p_fields ? 'sort_order'   THEN (p_fields ->> 'sort_order')::integer    ELSE e.sort_order END,
      is_published = CASE WHEN p_fields ? 'is_published' THEN (p_fields ->> 'is_published')::boolean  ELSE e.is_published END
  WHERE e.id = p_id
  RETURNING e.*;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'example_admin_not_found';
  END IF;
END;
$$;

CREATE FUNCTION public.replace_example_media_trusted(p_admin_user_id uuid, p_id uuid, p_media_url text)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_old text;
  v_row public.examples%ROWTYPE;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'example_admin_forbidden';
  END IF;
  IF p_id IS NULL OR p_media_url IS NULL OR p_media_url NOT LIKE 'examples/' || p_id::text || '/%'
     OR p_media_url LIKE '%..%' OR p_media_url ~ '^[A-Za-z][A-Za-z0-9+.-]*:' THEN
    RAISE EXCEPTION 'example_admin_invalid_media';
  END IF;

  SELECT e.media_url INTO v_old FROM public.examples e WHERE e.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'example_admin_not_found';
  END IF;

  UPDATE public.examples e SET media_url = p_media_url WHERE e.id = p_id RETURNING e.* INTO v_row;
  RETURN pg_catalog.jsonb_build_object('example', pg_catalog.to_jsonb(v_row), 'previous_media_url', v_old);
END;
$$;

CREATE FUNCTION public.delete_example_trusted(p_admin_user_id uuid, p_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_row public.examples%ROWTYPE;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'example_admin_forbidden';
  END IF;
  DELETE FROM public.examples e WHERE e.id = p_id RETURNING e.* INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'example_admin_not_found';
  END IF;
  RETURN pg_catalog.to_jsonb(v_row);
END;
$$;

COMMENT ON FUNCTION public.create_example_trusted IS 'Trusted examples CMS insert (V0.1.53): admin role re-checked, input validated, object key must be examples/<id>/...';
COMMENT ON FUNCTION public.update_example_trusted IS 'Trusted examples CMS partial update (V0.1.53): only title, badge_label, description, kind, sort_order, is_published; admin role re-checked.';
COMMENT ON FUNCTION public.replace_example_media_trusted IS 'Trusted examples CMS media swap (V0.1.53): returns the previous object key for best-effort cleanup.';
COMMENT ON FUNCTION public.delete_example_trusted IS 'Trusted examples CMS delete (V0.1.53): returns the deleted row.';

REVOKE ALL ON FUNCTION public.create_example_trusted(uuid, uuid, text, text, text, text, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_example_trusted(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_example_media_trusted(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_example_trusted(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_parent_referral_code_trusted(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_parent_referral_summary_trusted(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_referral_overview_trusted(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_referral_relationships_trusted(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_admin_referral_program_settings_trusted(uuid, boolean, integer, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_homepage_content_trusted(uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_homepage_media_replacement_trusted(uuid, text, text, text, text, bigint, integer, integer, numeric, jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_homepage_media_trusted(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_homepage_hero_layout_trusted(uuid, jsonb, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_example_trusted(uuid, uuid, text, text, text, text, text, boolean, integer) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.update_example_trusted(uuid, uuid, jsonb) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.replace_example_media_trusted(uuid, uuid, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.delete_example_trusted(uuid, uuid) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.bind_parent_referral_code_trusted(uuid, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.get_parent_referral_summary_trusted(uuid) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.get_admin_referral_overview_trusted(uuid) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.get_admin_referral_relationships_trusted(uuid, text, integer, integer) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.update_admin_referral_program_settings_trusted(uuid, boolean, integer, timestamp with time zone) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.update_homepage_content_trusted(uuid, jsonb, integer) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.record_homepage_media_replacement_trusted(uuid, text, text, text, text, bigint, integer, integer, numeric, jsonb, integer, boolean) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.delete_homepage_media_trusted(uuid, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.update_homepage_hero_layout_trusted(uuid, jsonb, integer) TO cartoona_app;

GRANT SELECT ON public.homepage_content, public.homepage_media_assets, public.homepage_hero_layout, public.examples TO cartoona_app;

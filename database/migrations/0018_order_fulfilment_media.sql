-- Cartoona plain-PostgreSQL (V0.1.52) - order detail, gallery, final media, admin fulfilment
--
-- Order and media METADATA are read, and fulfilment state is written, only in
-- this database. Storage OBJECT BYTES stay in the storage provider: this
-- migration touches no bytes and reads no storage schema; a media row holds the
-- object KEY, MIME type, size, role and visibility, and Cartoona authorizes
-- every access from those rows BEFORE any signed URL is minted.
--
-- Nothing here changes a state machine. The fulfilment functions already exist
-- (0005, ported from Supabase, bodies untouched): update_order_status_trusted
-- (lock, optimistic updated_at, in-database transition map, final media required
-- for ready, reason for rejected, order update + append-only history in ONE
-- statement), record/approve/supersede_final_media_trusted. This migration
-- makes them callable by the backend role and adds the one missing write:
--
--   record_final_media_access_audit_trusted   the audit row for a parent viewing /
--                                             downloading a final deliverable
--                                             (was an admin-client insert into
--                                             Supabase audit_logs)
--
-- Privileges. EXECUTE on the five fulfilment functions + the audit function,
-- SELECT on the three tables the reads need (media_assets, video_requests,
-- drawing_animation_requests; orders, order_status_history, characters,
-- parent_profiles, users are already readable). Still no INSERT/UPDATE/DELETE on
-- orders, order_status_history, media_assets or audit_logs.

CREATE FUNCTION public.record_final_media_access_audit_trusted(
    p_actor_user_id uuid, p_order_id uuid, p_asset_id uuid, p_action text)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('final_media_view', 'final_media_download') THEN
    RAISE EXCEPTION 'audit_action_invalid';
  END IF;

  -- Only the OWNING parent, only for the order's current approved, parent-visible
  -- final deliverable: nothing else can be recorded as an access.
  IF NOT EXISTS (
    SELECT 1
    FROM public.media_assets ma
    JOIN public.orders o ON o.id = ma.order_id
    JOIN public.parent_profiles pp ON pp.id = o.parent_id
    WHERE ma.id = p_asset_id
      AND ma.order_id = p_order_id
      AND pp.user_id = p_actor_user_id
      AND ma.asset_role = 'final'
      AND ma.delivery_status = 'approved'
      AND ma.parent_visible = TRUE
  ) THEN
    RAISE EXCEPTION 'audit_not_allowed';
  END IF;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (p_actor_user_id, p_action, 'media_asset', p_asset_id, pg_catalog.jsonb_build_object('orderId', p_order_id));
  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public.record_final_media_access_audit_trusted IS 'Trusted audit write (V0.1.52): records that the owning parent was given access to the current approved final deliverable. Refuses anything else; stores only ids.';

REVOKE ALL ON FUNCTION public.record_final_media_access_audit_trusted(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_status_trusted(uuid, uuid, text, timestamp with time zone, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_final_media_trusted(uuid, uuid, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_final_media_trusted(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supersede_final_media_trusted(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_status_history_admin_trusted(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.record_final_media_access_audit_trusted(uuid, uuid, uuid, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.update_order_status_trusted(uuid, uuid, text, timestamp with time zone, text, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.record_final_media_trusted(uuid, uuid, text, text, integer, text) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.approve_final_media_trusted(uuid, uuid, uuid) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.supersede_final_media_trusted(uuid, uuid, uuid) TO cartoona_app;
GRANT EXECUTE ON FUNCTION public.get_order_status_history_admin_trusted(uuid, uuid) TO cartoona_app;

GRANT SELECT ON public.media_assets, public.video_requests, public.drawing_animation_requests TO cartoona_app;

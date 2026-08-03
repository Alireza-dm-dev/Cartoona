-- =============================================================================
-- Migration: request_fulfilment_workflow
-- Admin request fulfilment workflow: controlled status transitions, append-only
-- activity history, final-media delivery, private final-deliverables storage,
-- and parent visibility boundary.
--
-- Principles (see docs/REQUEST_FULFILMENT_ARCHITECTURE.md):
--   * No NEW order status values. The existing 8 statuses are sufficient for the
--     MVP workflow: pending_review (submitted/under review), in_progress
--     (approved + in production), ready, delivered, rejected, cancelled.
--   * All order/status/media mutations go through service-role-only trusted RPCs.
--   * order_status_history is append-only. No update or delete (except cascade
--     from orders parent deletion, which is out of scope).
--   * Internal notes are never readable by parents.
--   * Final media is private until explicitly approved (parent_visible=true).
--   * No candy/wallet/ledger mutation. No automatic refunds.
--   * No data creation / no file uploads / no orders created.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. order_status_history — append-only activity/audit log
--    Parents may never SELECT this table directly. Internal notes are exposed
--    ONLY through the admin read function (get_order_status_history_admin).
--    Parents read only parent-visible notes through get_parent_order_status_history.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_status_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  previous_status    TEXT NULL,
  new_status         TEXT NOT NULL,
  changed_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  internal_note      TEXT NULL,
  parent_visible_note TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_status_history_previous_status_check
    CHECK (previous_status IS NULL OR previous_status IN
      ('draft', 'pending_payment', 'pending_review', 'in_progress', 'ready', 'delivered', 'rejected', 'cancelled')),
  CONSTRAINT order_status_history_new_status_check
    CHECK (new_status IN
      ('draft', 'pending_payment', 'pending_review', 'in_progress', 'ready', 'delivered', 'rejected', 'cancelled')),
  CONSTRAINT order_status_history_internal_note_len_check
    CHECK (internal_note IS NULL OR char_length(internal_note) <= 2000),
  CONSTRAINT order_status_history_parent_note_len_check
    CHECK (parent_visible_note IS NULL OR char_length(parent_visible_note) <= 2000)
);

COMMENT ON TABLE public.order_status_history IS
  'Append-only status-change audit for orders. Never updated or deleted directly. '
  'Internal notes are admin-only; parents read only parent_visible_note via the '
  'dedicated SECURITY DEFINER function.';
COMMENT ON COLUMN public.order_status_history.internal_note IS
  'Admin-only note. Never exposed through any parent-facing query/API.';
COMMENT ON COLUMN public.order_status_history.parent_visible_note IS
  'Optional message shown to the parent for this status change.';

CREATE INDEX IF NOT EXISTS idx_order_status_history_order_created
  ON public.order_status_history (order_id, created_at DESC);

-- Append-only enforcement. Direct UPDATE/DELETE raise. FK cascades from a parent
-- orders deletion (pg_trigger_depth() > 0) are allowed to propagate.
CREATE OR REPLACE FUNCTION public.order_status_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR (TG_OP IN ('UPDATE', 'DELETE') AND pg_trigger_depth() = 0) THEN
    RAISE EXCEPTION 'order_status_history_append_only'
      USING HINT = 'History rows are append-only and cannot be updated or deleted directly.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS order_status_history_append_only_trigger ON public.order_status_history;
CREATE TRIGGER order_status_history_append_only_trigger
  BEFORE UPDATE OR DELETE ON public.order_status_history
  FOR EACH ROW
  EXECUTE FUNCTION public.order_status_history_append_only();

DROP TRIGGER IF EXISTS order_status_history_truncate_block ON public.order_status_history;
CREATE TRIGGER order_status_history_truncate_block
  BEFORE TRUNCATE ON public.order_status_history
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.order_status_history_append_only();

-- RLS enabled; browser roles get NO grants on the table (data flows through
-- SECURITY DEFINER read functions only).
ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_status_history FROM anon;
REVOKE ALL ON public.order_status_history FROM authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. media_assets — final-media model extension
--    asset_role: source | final | preview | supporting
--    delivery_status: uploaded | approved | superseded (only final/preview)
--    parent_visible: true only after explicit admin approval
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS asset_role TEXT NOT NULL DEFAULT 'source',
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS original_filename TEXT,
  ADD COLUMN IF NOT EXISTS byte_size INTEGER,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_visible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Safe backfill: existing rows are all parent source uploads.
UPDATE public.media_assets SET asset_role = 'source'
  WHERE asset_role IS NULL;

ALTER TABLE public.media_assets
  ALTER COLUMN asset_role SET NOT NULL;

-- Invariants for final/preview assets.
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_asset_role_check
    CHECK (asset_role IN ('source', 'final', 'preview', 'supporting'));

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_delivery_status_check
    CHECK (delivery_status IS NULL OR delivery_status IN ('uploaded', 'approved', 'superseded'));

-- Final/preview assets must carry a delivery status.
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_final_has_delivery_check
    CHECK (asset_role NOT IN ('final', 'preview') OR delivery_status IS NOT NULL);

-- Only final/preview assets are generated output.
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_final_type_generated_check
    CHECK (asset_role NOT IN ('final', 'preview') OR type = 'generated');

-- superseded_at only makes sense when superseded; superseded assets are hidden.
ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_superseded_invariants_check
    CHECK (
      (superseded_at IS NOT NULL AND delivery_status = 'superseded')
      OR (superseded_at IS NULL AND delivery_status IS DISTINCT FROM 'superseded')
    );

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_superseded_hidden_check
    CHECK (delivery_status <> 'superseded' OR (parent_visible = FALSE));

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_byte_size_positive_check
    CHECK (byte_size IS NULL OR byte_size >= 0);

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_filename_len_check
    CHECK (original_filename IS NULL OR char_length(original_filename) <= 255);

COMMENT ON COLUMN public.media_assets.asset_role IS
  'source (parent input) | final (admin deliverable) | preview | supporting.';
COMMENT ON COLUMN public.media_assets.delivery_status IS
  'uploaded → approved (parent-visible) → superseded (hidden, history kept).';
COMMENT ON COLUMN public.media_assets.parent_visible IS
  'False until an admin explicitly approves the asset. Only approved final '
  'assets are ever exposed to parents.';

-- updated_at trigger for supersede/approve updates.
DROP TRIGGER IF EXISTS media_assets_set_updated_at ON public.media_assets;
CREATE TRIGGER media_assets_set_updated_at
  BEFORE UPDATE ON public.media_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_media_assets_order_role_status
  ON public.media_assets (order_id, asset_role, delivery_status, parent_visible);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Parent media_assets boundary — tighten the existing parent SELECT policy
--    Parents may now read only source assets and APPROVED final assets of their
--    own orders. Unapproved/superseded finals and raw storage paths stay hidden.
-- ═════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS media_assets_select_own_parent ON public.media_assets;

CREATE POLICY media_assets_select_own_parent ON public.media_assets
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = media_assets.order_id
        AND orders.parent_id = public.current_parent_profile_id()
    )
    AND (
      media_assets.asset_role = 'source'
      OR (
        media_assets.asset_role = 'final'
        AND media_assets.delivery_status = 'approved'
        AND media_assets.parent_visible = TRUE
      )
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Private final-deliverables storage bucket
--    Path strategy: orders/<order-id>/final/<uuid>.<ext>
--    Admin CRUD; parent SELECT only for approved final assets of their own order.
--    Never public. Signed URLs are generated on demand and never persisted.
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'final-deliverables',
  'final-deliverables',
  FALSE,
  104857600,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Parent-approved-final helper used by the storage SELECT policy. SECURITY
-- DEFINER (owner = postgres) so it can verify the asset row without RLS
-- recursion. Verifies: path = orders/<order-id>/final/..., the order belongs to
-- the current parent, and the media_assets row is approved + parent-visible.
CREATE OR REPLACE FUNCTION public.is_parent_approved_final_deliverable(p_path TEXT)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.media_assets ma
    JOIN public.orders o ON o.id = ma.order_id
    WHERE ma.file_url = p_path
      AND ma.asset_role = 'final'
      AND ma.delivery_status = 'approved'
      AND ma.parent_visible = TRUE
      AND o.parent_id = public.current_parent_profile_id()
  );
$$;

REVOKE ALL ON FUNCTION public.is_parent_approved_final_deliverable(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_parent_approved_final_deliverable(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_parent_approved_final_deliverable(TEXT) TO authenticated;

-- Admin CRUD
CREATE POLICY final_deliverables_insert_admin ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'final-deliverables' AND public.is_admin());

CREATE POLICY final_deliverables_select_admin ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'final-deliverables' AND public.is_admin());

CREATE POLICY final_deliverables_update_admin ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'final-deliverables' AND public.is_admin())
  WITH CHECK (bucket_id = 'final-deliverables' AND public.is_admin());

CREATE POLICY final_deliverables_delete_admin ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'final-deliverables' AND public.is_admin());

-- Parent SELECT: approved final assets of the parent's own order only.
CREATE POLICY final_deliverables_select_parent ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'final-deliverables'
    AND public.is_parent_approved_final_deliverable(name)
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. update_order_status_trusted — atomic status transition + history insert
--    service_role only. Locks the order, verifies optimistic concurrency,
--    validates the transition, requires approved final media for ready and a
--    reason for rejected, then updates status and appends history atomically.
--    No candy/wallet/ledger mutation.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_order_status_trusted(
  p_order_id            UUID,
  p_admin_user_id       UUID,
  p_new_status          TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_internal_note       TEXT,
  p_parent_visible_note TEXT
)
RETURNS TABLE (
  order_id       UUID,
  previous_status TEXT,
  new_status     TEXT,
  updated_at     TIMESTAMPTZ,
  history_id     UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous_status TEXT;
  v_current_updated_at TIMESTAMPTZ;
  v_internal_note TEXT;
  v_parent_note TEXT;
  v_history_id UUID;
BEGIN
  -- 1. Admin role check (defense in depth; callable only by service_role anyway).
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  -- 2. Notes: trim whitespace; empty becomes NULL; enforce 2000 char max.
  v_internal_note := trim(COALESCE(p_internal_note, ''));
  IF v_internal_note = '' THEN v_internal_note := NULL; END IF;
  IF v_internal_note IS NOT NULL AND char_length(v_internal_note) > 2000 THEN
    RAISE EXCEPTION 'request_note_too_long' USING HINT = 'Internal note must not exceed 2000 characters.';
  END IF;

  v_parent_note := trim(COALESCE(p_parent_visible_note, ''));
  IF v_parent_note = '' THEN v_parent_note := NULL; END IF;
  IF v_parent_note IS NOT NULL AND char_length(v_parent_note) > 2000 THEN
    RAISE EXCEPTION 'request_note_too_long' USING HINT = 'Parent-visible note must not exceed 2000 characters.';
  END IF;

  -- 3. Lock the order and load its current state.
  SELECT o.status, o.updated_at
    INTO v_previous_status, v_current_updated_at
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_previous_status IS NULL THEN
    RAISE EXCEPTION 'request_not_found' USING HINT = 'Order not found.';
  END IF;

  -- 4. Optimistic concurrency: the caller must hold the latest updated_at.
  IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'request_status_conflict'
      USING HINT = 'The order was changed by another admin. Reload and retry.';
  END IF;

  -- 5. Target status must be a known order status.
  IF p_new_status NOT IN ('draft','pending_payment','pending_review','in_progress','ready','delivered','rejected','cancelled') THEN
    RAISE EXCEPTION 'request_invalid_status' USING HINT = 'Unknown target status.';
  END IF;

  -- 6. No-op guard.
  IF p_new_status = v_previous_status THEN
    RAISE EXCEPTION 'request_status_unchanged' USING HINT = 'Status is already the target status.';
  END IF;

  -- 7. Transition validity. Mirrors lib/admin/requests/workflow.ts.
  --    Operational workflow: pending_review → in_progress → ready → delivered;
  --    rejection/cancellation from pending_review or in_progress. Terminals never reopen.
  IF NOT (
    (v_previous_status = 'pending_review' AND p_new_status IN ('in_progress','rejected','cancelled'))
    OR (v_previous_status = 'in_progress' AND p_new_status IN ('ready','rejected','cancelled'))
    OR (v_previous_status = 'ready' AND p_new_status = 'delivered')
  ) THEN
    RAISE EXCEPTION 'request_transition_invalid' USING HINT = 'Transition is not allowed for this status.';
  END IF;

  -- 8. Rejection requires a reason (internal or parent-visible).
  IF p_new_status = 'rejected' AND v_internal_note IS NULL AND v_parent_note IS NULL THEN
    RAISE EXCEPTION 'request_rejection_reason_required'
      USING HINT = 'Provide an internal or parent-visible rejection reason.';
  END IF;

  -- 9. Ready requires at least one approved, parent-visible final asset.
  IF p_new_status = 'ready' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.media_assets ma
      WHERE ma.order_id = p_order_id
        AND ma.asset_role = 'final'
        AND ma.delivery_status = 'approved'
        AND ma.parent_visible = TRUE
    ) THEN
      RAISE EXCEPTION 'request_final_media_required'
        USING HINT = 'At least one approved final asset is required before ready.';
    END IF;
  END IF;

  -- 10. Update status + updated_at (orders has no updated_at trigger).
  UPDATE public.orders o
  SET status = p_new_status,
      updated_at = now()
  WHERE o.id = p_order_id;

  -- 11. Append history atomically.
  INSERT INTO public.order_status_history (
    order_id, previous_status, new_status, changed_by_user_id,
    internal_note, parent_visible_note
  ) VALUES (
    p_order_id, v_previous_status, p_new_status, p_admin_user_id,
    v_internal_note, v_parent_note
  )
  RETURNING id INTO v_history_id;

  -- 12. Controlled result.
  RETURN QUERY
  SELECT o.id, v_previous_status, o.status, o.updated_at, v_history_id
  FROM public.orders o
  WHERE o.id = p_order_id;
END;
$$;

COMMENT ON FUNCTION public.update_order_status_trusted IS
  'Trusted service-role-only status transition. Locks the order FOR UPDATE, '
  'verifies expectedUpdatedAt (optimistic concurrency), validates the transition '
  'in-database, requires approved final media for ready and a reason for '
  'rejected, then updates the order and appends order_status_history atomically. '
  'No financial mutation.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. record_final_media_trusted — metadata insert for an uploaded final asset
--    service_role only. Re-verifies admin role, order status, path safety, and
--    that the storage object actually exists with the claimed MIME type.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_final_media_trusted(
  p_admin_user_id     UUID,
  p_order_id          UUID,
  p_file_path         TEXT,
  p_mime_type         TEXT,
  p_byte_size         INTEGER,
  p_original_filename TEXT
)
RETURNS TABLE (
  asset_id       UUID,
  asset_role     TEXT,
  delivery_status TEXT,
  parent_visible BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_status TEXT;
  v_trusted_mime TEXT;
  v_filename     TEXT;
  v_asset_id     UUID;
BEGIN
  -- 1. Admin role check.
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  -- 2. Order exists and its status allows final upload.
  SELECT o.status INTO v_order_status
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_order_status IS NULL THEN
    RAISE EXCEPTION 'request_not_found' USING HINT = 'Order not found.';
  END IF;

  IF v_order_status NOT IN ('pending_review', 'in_progress', 'ready') THEN
    RAISE EXCEPTION 'request_upload_not_allowed'
      USING HINT = 'Final upload is not allowed for this status.';
  END IF;

  -- 3. Path safety: relative, no traversal, exact prefix orders/<order-id>/final/.
  IF p_file_path IS NULL OR p_file_path LIKE '/%' THEN
    RAISE EXCEPTION 'request_invalid_path' USING HINT = 'Storage path must be relative.';
  END IF;
  IF p_file_path LIKE '%/../%' OR p_file_path LIKE '../%' OR p_file_path LIKE '%/..' OR p_file_path = '..' THEN
    RAISE EXCEPTION 'request_invalid_path' USING HINT = 'Path traversal is not allowed.';
  END IF;
  IF p_file_path NOT LIKE 'orders/' || p_order_id::text || '/final/%' THEN
    RAISE EXCEPTION 'request_invalid_path'
      USING HINT = 'Storage path must match orders/<order-id>/final/<filename>.';
  END IF;

  -- 4. The storage object must actually exist and its MIME must match.
  SELECT metadata->>'mimetype' INTO v_trusted_mime
  FROM storage.objects
  WHERE bucket_id = 'final-deliverables'
    AND name = p_file_path;

  IF v_trusted_mime IS NULL THEN
    RAISE EXCEPTION 'request_file_not_found' USING HINT = 'Uploaded object not found in storage.';
  END IF;

  IF v_trusted_mime IS DISTINCT FROM p_mime_type THEN
    RAISE EXCEPTION 'request_file_invalid' USING HINT = 'Stored MIME type does not match the claimed type.';
  END IF;

  -- 5. Filename length + byte size sanity.
  v_filename := trim(COALESCE(p_original_filename, ''));
  IF v_filename = '' THEN v_filename := 'final'; END IF;
  IF char_length(v_filename) > 255 THEN
    v_filename := left(v_filename, 255);
  END IF;
  IF p_byte_size IS NULL OR p_byte_size < 0 THEN
    RAISE EXCEPTION 'request_file_invalid' USING HINT = 'Invalid byte size.';
  END IF;

  -- 6. Insert metadata. type=generated, asset_role=final, delivery_status=uploaded,
  --    parent_visible=false until explicit approval.
  INSERT INTO public.media_assets (
    order_id, type, asset_role, delivery_status, file_url, mime_type,
    uploaded_by_user_id, original_filename, byte_size, parent_visible, moderation_status
  ) VALUES (
    p_order_id, 'generated', 'final', 'uploaded', p_file_path, p_mime_type,
    p_admin_user_id, v_filename, p_byte_size, FALSE, 'pending'
  )
  RETURNING id INTO v_asset_id;

  -- 7. Controlled result.
  RETURN QUERY
  SELECT v_asset_id, 'final'::TEXT, 'uploaded'::TEXT, FALSE;
END;
$$;

COMMENT ON FUNCTION public.record_final_media_trusted IS
  'Trusted service-role-only final-media metadata insert. Re-verifies admin role, '
  'order status allows upload, path safety/prefix, and that the storage object '
  'exists with a matching MIME. Inserts an uploaded, non-parent-visible final '
  'asset. On failure the API route removes the uploaded object.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. approve_final_media_trusted / supersede_final_media_trusted
--    service_role only. Asset must belong to the order and be a final asset.
--    Approve: uploaded → approved + parent_visible. Supersede: uploaded/approved
--    → superseded + hidden + superseded_at. No delete.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.approve_final_media_trusted(
  p_admin_user_id UUID,
  p_asset_id      UUID,
  p_order_id      UUID
)
RETURNS TABLE (
  asset_id       UUID,
  asset_role     TEXT,
  delivery_status TEXT,
  parent_visible BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role     TEXT;
  v_delivery TEXT;
  v_order_id UUID;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  SELECT ma.asset_role, ma.delivery_status, ma.order_id
    INTO v_role, v_delivery, v_order_id
  FROM public.media_assets ma
  WHERE ma.id = p_asset_id
  FOR UPDATE;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset not found.';
  END IF;
  IF v_order_id IS DISTINCT FROM p_order_id THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset does not belong to this order.';
  END IF;
  IF v_role <> 'final' THEN
    RAISE EXCEPTION 'request_asset_not_final' USING HINT = 'Only final assets can be approved.';
  END IF;
  IF v_delivery IS DISTINCT FROM 'uploaded' THEN
    RAISE EXCEPTION 'request_asset_not_uploaded'
      USING HINT = 'Only uploaded assets can be approved for parent visibility.';
  END IF;

  UPDATE public.media_assets
  SET delivery_status = 'approved',
      parent_visible  = TRUE
  WHERE id = p_asset_id;

  RETURN QUERY
  SELECT p_asset_id, v_role, 'approved'::TEXT, TRUE;
END;
$$;

COMMENT ON FUNCTION public.approve_final_media_trusted IS
  'Trusted service-role-only approval: marks an uploaded final asset as approved '
  'and parent-visible. Requires the asset to belong to the given order.';

CREATE OR REPLACE FUNCTION public.supersede_final_media_trusted(
  p_admin_user_id UUID,
  p_asset_id      UUID,
  p_order_id      UUID
)
RETURNS TABLE (
  asset_id       UUID,
  asset_role     TEXT,
  delivery_status TEXT,
  parent_visible BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role     TEXT;
  v_delivery TEXT;
  v_order_id UUID;
BEGIN
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'request_admin_forbidden' USING HINT = 'Admin role required.';
  END IF;

  SELECT ma.asset_role, ma.delivery_status, ma.order_id
    INTO v_role, v_delivery, v_order_id
  FROM public.media_assets ma
  WHERE ma.id = p_asset_id
  FOR UPDATE;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset not found.';
  END IF;
  IF v_order_id IS DISTINCT FROM p_order_id THEN
    RAISE EXCEPTION 'request_asset_not_found' USING HINT = 'Asset does not belong to this order.';
  END IF;
  IF v_role <> 'final' THEN
    RAISE EXCEPTION 'request_asset_not_final' USING HINT = 'Only final assets can be superseded.';
  END IF;
  IF v_delivery NOT IN ('uploaded', 'approved') THEN
    RAISE EXCEPTION 'request_asset_already_superseded'
      USING HINT = 'This asset is already superseded.';
  END IF;

  UPDATE public.media_assets
  SET delivery_status = 'superseded',
      parent_visible  = FALSE,
      superseded_at   = now()
  WHERE id = p_asset_id;

  RETURN QUERY
  SELECT p_asset_id, v_role, 'superseded'::TEXT, FALSE;
END;
$$;

COMMENT ON FUNCTION public.supersede_final_media_trusted IS
  'Trusted service-role-only supersede: hides an uploaded/approved final asset, '
  'keeps history, and stamps superseded_at. No permanent deletion.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Read functions — safe, narrowed history access
--    get_order_status_history_admin: admins/super_admins (via auth.uid()).
--    get_parent_order_status_history: parents for their own order; safe columns
--    only (no internal notes, no admin identity).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_order_status_history_admin(p_order_id UUID)
RETURNS TABLE (
  id                  UUID,
  previous_status     TEXT,
  new_status          TEXT,
  changed_by_name     TEXT,
  changed_by_deleted  BOOLEAN,
  internal_note       TEXT,
  parent_visible_note TEXT,
  created_at          TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin_or_super_admin() THEN
    RAISE EXCEPTION 'request_forbidden' USING HINT = 'Admin role required.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_order_id) THEN
    RAISE EXCEPTION 'request_not_found' USING HINT = 'Order not found.';
  END IF;

  RETURN QUERY
  SELECT h.id, h.previous_status, h.new_status,
         u.email AS changed_by_name,
         (u.id IS NULL OR u.deleted_at IS NOT NULL) AS changed_by_deleted,
         h.internal_note, h.parent_visible_note, h.created_at
  FROM public.order_status_history h
  LEFT JOIN public.users u ON u.id = h.changed_by_user_id
  WHERE h.order_id = p_order_id
  ORDER BY h.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_order_status_history_admin IS
  'Admin-only history read. Returns internal notes and a safe admin display '
  'name (email). Never returns auth user IDs to the client; the API maps the '
  'result to a safe model.';

CREATE OR REPLACE FUNCTION public.get_parent_order_status_history(p_order_id UUID)
RETURNS TABLE (
  previous_status     TEXT,
  new_status          TEXT,
  parent_visible_note TEXT,
  created_at          TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = p_order_id
      AND o.parent_id = public.current_parent_profile_id()
  ) THEN
    RAISE EXCEPTION 'request_forbidden' USING HINT = 'Order is not accessible to this account.';
  END IF;

  RETURN QUERY
  SELECT h.previous_status, h.new_status, h.parent_visible_note, h.created_at
  FROM public.order_status_history h
  WHERE h.order_id = p_order_id
  ORDER BY h.created_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_parent_order_status_history IS
  'Parent-safe history read for the parent''s own order. Exposes status and '
  'parent_visible_note only — internal notes and admin identity are never '
  'returned.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Privileges
--    Trusted mutation RPCs: service_role only.
--    Read functions: authenticated only (both parents and admins hold sessions).
--    No browser role can INSERT/UPDATE/DELETE orders, media_assets, or history
--    directly (existing grants already restrict orders/media to SELECT).
-- ═════════════════════════════════════════════════════════════════════════════

-- Status update
REVOKE ALL ON FUNCTION public.update_order_status_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_status_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.update_order_status_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_status_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO service_role;

-- Final media metadata insert
REVOKE ALL ON FUNCTION public.record_final_media_trusted(UUID, UUID, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_final_media_trusted(UUID, UUID, TEXT, TEXT, INTEGER, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.record_final_media_trusted(UUID, UUID, TEXT, TEXT, INTEGER, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_final_media_trusted(UUID, UUID, TEXT, TEXT, INTEGER, TEXT) TO service_role;

-- Approve / supersede
REVOKE ALL ON FUNCTION public.approve_final_media_trusted(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_final_media_trusted(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.approve_final_media_trusted(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.approve_final_media_trusted(UUID, UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.supersede_final_media_trusted(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.supersede_final_media_trusted(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.supersede_final_media_trusted(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_final_media_trusted(UUID, UUID, UUID) TO service_role;

-- Read functions — authenticated only
REVOKE ALL ON FUNCTION public.get_order_status_history_admin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_status_history_admin(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_order_status_history_admin(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.get_parent_order_status_history(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_parent_order_status_history(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_parent_order_status_history(UUID) TO authenticated;

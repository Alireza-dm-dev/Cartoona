-- Migration: order_request_read_rls
-- Enables RLS and creates read-only policies for the four order/request tables.
--
-- Background:
--   Parents must be able to SELECT their own records (orders, media_assets,
--   video_requests, drawing_animation_requests) after submission so the
--   dashboard order list and detail pages can display real data.
--   Admins must be able to SELECT all records so the admin request queue
--   can show incoming submissions.
--   Direct INSERT/UPDATE/DELETE are NOT granted to any client role — all
--   parent request creation flows through the create_parent_request RPC.
--
-- Changes:
--   1. Enable RLS on the four tables.
--   2. REVOKE all default privileges from anon and authenticated.
--   3. GRANT SELECT to authenticated (the only parent/admin access path).
--   4. Create parent own-SELECT policies (via current_parent_profile_id()).
--   5. Create admin SELECT-all policies (via is_admin()).
--
-- Preserves:
--   - Existing RLS on users, parent_profiles, characters, examples.
--   - Existing storage RLS.
--   - Existing  is_parent(), is_admin(), current_parent_profile_id() helpers.
--   - Existing indexes.
--   - All later status-update and fulfillment tasks are unblocked.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Enable Row-Level Security
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawing_animation_requests ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Revoke default broad grants
--    anon gets nothing. authenticated gets SELECT only — no INSERT/UPDATE/DELETE.
--    The create_parent_request RPC is the sole write path for parent requests.
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.orders FROM anon, authenticated;
REVOKE ALL ON public.media_assets FROM anon, authenticated;
REVOKE ALL ON public.video_requests FROM anon, authenticated;
REVOKE ALL ON public.drawing_animation_requests FROM anon, authenticated;

GRANT SELECT ON public.orders TO authenticated;
GRANT SELECT ON public.media_assets TO authenticated;
GRANT SELECT ON public.video_requests TO authenticated;
GRANT SELECT ON public.drawing_animation_requests TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Orders — SELECT policies
-- ═════════════════════════════════════════════════════════════════════════════

-- Parent: select only orders linked to own parent profile
CREATE POLICY orders_select_own_parent ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND parent_id = public.current_parent_profile_id()
  );

-- Admin: select all orders
CREATE POLICY orders_select_admin ON public.orders
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Media Assets — SELECT policies
-- ═════════════════════════════════════════════════════════════════════════════

-- Parent: select only assets belonging to own orders
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
  );

-- Admin: select all media assets
CREATE POLICY media_assets_select_admin ON public.media_assets
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Video Requests — SELECT policies
-- ═════════════════════════════════════════════════════════════════════════════

-- Parent: select only video requests linked to own orders
CREATE POLICY video_requests_select_own_parent ON public.video_requests
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = video_requests.order_id
      AND orders.parent_id = public.current_parent_profile_id()
    )
  );

-- Admin: select all video requests
CREATE POLICY video_requests_select_admin ON public.video_requests
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Drawing Animation Requests — SELECT policies
-- ═════════════════════════════════════════════════════════════════════════════

-- Parent: select only drawing requests linked to own orders
CREATE POLICY drawing_animation_requests_select_own_parent
  ON public.drawing_animation_requests
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = drawing_animation_requests.order_id
      AND orders.parent_id = public.current_parent_profile_id()
    )
  );

-- Admin: select all drawing animation requests
CREATE POLICY drawing_animation_requests_select_admin
  ON public.drawing_animation_requests
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

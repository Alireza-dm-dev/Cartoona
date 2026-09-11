-- =============================================================================
-- Cartoona — Homepage CMS Admin Write Path (Phase 2)
-- =============================================================================
-- Adds the server-side write path for the homepage editor:
--
--   public.update_homepage_content_trusted(
--     p_admin_user_id       UUID,   -- verified admin, re-checked server-side
--     p_content_json        JSONB,  -- validated HomepageContent
--     p_expected_revision   INTEGER -- optimistic concurrency guard
--   ) RETURNS JSONB
--
-- Conventions (mirrors 20260801110000_admin_coupon_management.sql):
--   * Trusted RPC in `public`, SECURITY DEFINER, SET search_path = '',
--     all references public-qualified, EXECUTE granted only to service_role.
--   * The admin API route authenticates the session, resolves the verified
--     admin user id, and passes it in. The RPC re-verifies the admin role
--     server-side via public.is_admin_user_id (defense in depth) — it never
--     trusts auth.uid() and never trusts a browser payload.
--   * Error signalling uses short codes as the exception message
--     (homepage_admin_forbidden / homepage_admin_conflict / ...), mapped to
--     Persian HTTP errors by lib/admin/homepage/errors.ts. Raw DB strings
--     never reach the browser.
--
-- Behaviour:
--   * Locks the singleton row (FOR UPDATE) to serialize concurrent updates.
--   * Enforces optimistic concurrency via `revision`: fails with
--     `homepage_admin_conflict` when the caller's expected revision is stale.
--   * Structural safety net: requires a JSON object with all eight sections.
--     Deep field validation happens in the application
--     (lib/homepage/validation.ts) before the RPC is called.
--   * Bumps revision atomically, stamps updated_by_user_id / updated_at.
--   * Returns jsonb_build_object(content_json, revision, updated_at,
--     updated_by_user_id) for the caller.
--
-- Boundary: code owns structure, admin owns content. This RPC cannot express
-- layout, scroll behaviour, breakpoints, CSS, HTML or script.
--
-- Scope note: touches ONLY the RPC below. No table changes, no seeds, no
-- reads/writes to users, wallets, purchases, coupons, referrals or requests.
-- No upload API, no storage bucket (later phase).
-- =============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- update_homepage_content_trusted — service_role only
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_homepage_content_trusted(
  p_admin_user_id       UUID,
  p_content_json        JSONB,
  p_expected_revision   INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
  v_current_revision INTEGER;
  v_new_revision INTEGER;
BEGIN
  -- 1. Admin role check (defense in depth; callable only by service_role anyway).
  IF NOT public.is_admin_user_id(p_admin_user_id) THEN
    RAISE EXCEPTION 'homepage_admin_forbidden';
  END IF;

  -- 2. Lock the singleton row to serialize concurrent updates.
  SELECT public.homepage_content.revision
  INTO v_current_revision
  FROM public.homepage_content
  WHERE public.homepage_content.singleton_key = 'homepage'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'homepage_admin_not_found';
  END IF;

  -- 3. Optimistic concurrency guard.
  IF v_current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'homepage_admin_conflict';
  END IF;

  -- 4. Structural safety net (deep validation lives in the application).
  IF jsonb_typeof(p_content_json) <> 'object' THEN
    RAISE EXCEPTION 'homepage_admin_invalid';
  END IF;

  IF NOT (p_content_json ? 'hero') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'buildOptions') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'characters') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'safety') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'pricing') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'testimonials') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'faqTeaser') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;
  IF NOT (p_content_json ? 'finalCta') THEN RAISE EXCEPTION 'homepage_admin_invalid'; END IF;

  -- 5. Bump revision and update atomically.
  v_new_revision := v_current_revision + 1;

  UPDATE public.homepage_content
  SET content_json = p_content_json,
      revision = v_new_revision,
      updated_by_user_id = p_admin_user_id,
      updated_at = now()
  WHERE public.homepage_content.singleton_key = 'homepage';

  RETURN jsonb_build_object(
    'content_json', p_content_json,
    'revision', v_new_revision,
    'updated_at', now(),
    'updated_by_user_id', p_admin_user_id
  );
END;
$func$;

COMMENT ON FUNCTION public.update_homepage_content_trusted(UUID, JSONB, INTEGER) IS
  'Trusted server-only homepage content update. Callable only by service_role. Re-verifies admin role, enforces optimistic concurrency via revision, returns the new row snapshot.';

REVOKE ALL ON FUNCTION public.update_homepage_content_trusted(UUID, JSONB, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_homepage_content_trusted(UUID, JSONB, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.update_homepage_content_trusted(UUID, JSONB, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_homepage_content_trusted(UUID, JSONB, INTEGER) TO service_role;

-- Migration: parent_session_lifetime
-- Creates a SECURITY DEFINER function that enforces a hard, non-sliding
-- 30-day maximum lifetime for parent sessions.
--
-- The function derives identity only from auth.uid() and the JWT's
-- session_id claim.  It confirms the caller's role is 'parent' before
-- returning any session data.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Create the RPC function
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_current_parent_session_policy()
RETURNS TABLE (
  session_started_at TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  is_valid           BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id            UUID;
  v_session_id_text    TEXT;
  v_session_id         UUID;
  v_session_started_at TIMESTAMPTZ;
  v_expires_at         TIMESTAMPTZ;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Authentication check
  -- ═══════════════════════════════════════════════════════════════════════════
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RETURN QUERY
    SELECT NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, FALSE::BOOLEAN;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2. Parent-role enforcement
  -- ═══════════════════════════════════════════════════════════════════════════
  IF NOT EXISTS (
    SELECT 1
    FROM public.users AS u
    WHERE u.id = v_user_id
      AND u.role = 'parent'
  ) THEN
    RETURN QUERY
    SELECT NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, FALSE::BOOLEAN;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3. Extract session_id from JWT as text
  -- ═══════════════════════════════════════════════════════════════════════════
  v_session_id_text := auth.jwt() ->> 'session_id';

  IF v_session_id_text IS NULL
     OR pg_catalog.btrim(v_session_id_text) = '' THEN
    RETURN QUERY
    SELECT NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, FALSE::BOOLEAN;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 4. Safe UUID cast with narrow exception handler
  -- ═══════════════════════════════════════════════════════════════════════════
  BEGIN
    v_session_id := v_session_id_text::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN QUERY
      SELECT NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, FALSE::BOOLEAN;
      RETURN;
  END;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 5. Session ownership verification
  -- ═══════════════════════════════════════════════════════════════════════════
  SELECT s.created_at
  INTO v_session_started_at
  FROM auth.sessions AS s
  WHERE s.id = v_session_id
    AND s.user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, FALSE::BOOLEAN;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 6. Calculate exactly 30 days from session creation
  -- ═══════════════════════════════════════════════════════════════════════════
  v_expires_at := v_session_started_at + INTERVAL '30 days';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 7. Return policy: exactly 30 days means expired (strict <)
  -- ═══════════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT
    v_session_started_at,
    v_expires_at,
    pg_catalog.now() < v_expires_at;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Function comment
-- ═════════════════════════════════════════════════════════════════════════════
COMMENT ON FUNCTION public.get_current_parent_session_policy() IS
  'Returns the current parent session policy: session creation time, expiry '
  'time (created_at + 30 days), and whether the session is still valid. '
  'Parent-only. Non-sliding. Uses auth.sessions.created_at and the JWT '
  'session_id claim. Returns invalid row for non-parent, anonymous, '
  'or unmatched sessions.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Execution privileges
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE ALL
ON FUNCTION public.get_current_parent_session_policy()
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.get_current_parent_session_policy()
FROM anon;

REVOKE ALL
ON FUNCTION public.get_current_parent_session_policy()
FROM authenticated;

GRANT EXECUTE
ON FUNCTION public.get_current_parent_session_policy()
TO authenticated;

-- Cartoona plain-PostgreSQL (V0.1.48) - the parent consent write
--
-- POST /v1/parent/consent records the signed-in parent's consent
-- (lib/repositories/parent-profiles.ts recordParentConsent):
--
--   SELECT * FROM public.record_parent_consent_trusted($1)   -- $1 = principal.userId
--
-- Semantics are exactly the ones the Supabase route had (V0.1.47 and before,
-- lib/parent/ensure-parent-profile.ts):
--   * consent is ONE-WAY: false -> true. There is no revocation anywhere in
--     the product, and this function cannot set false.
--   * the first grant stamps consent_granted_at; a repeated grant changes
--     nothing (the original time is kept). Concurrent grants serialize on the
--     row lock and the loser's re-checked WHERE no longer matches, so the
--     timestamp is written once.
--   * updated_at is not touched (the Supabase consent update never did).
-- One deliberate narrowing: the Supabase route CREATED a missing profile.
-- This function never inserts (an insert would also fire the wallet and
-- welcome-credit triggers); a user without a profile gets no row back and the
-- backend answers 404 parent_profile_not_found.
--
-- Defence in depth: only a non-deleted 'parent' user's own row can change
-- (the backend has already required the parent role).
--
-- Privilege: cartoona_app gets EXECUTE on this one function and NO new table
-- privilege. It still cannot UPDATE consent_granted / consent_granted_at
-- directly (0013 granted UPDATE on full_name and updated_at only), cannot
-- INSERT or DELETE profiles, and the function can change nothing but these
-- two columns of one row. SECURITY DEFINER with an empty search_path, like
-- consume_internal_write_nonce (0012) and the *_trusted functions (0005).

CREATE FUNCTION public.record_parent_consent_trusted(p_user_id uuid)
    RETURNS TABLE (consent_granted boolean, consent_granted_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid user id' USING ERRCODE = '22023';
  END IF;

  UPDATE public.parent_profiles pp
  SET consent_granted = true,
      consent_granted_at = pg_catalog.now()
  FROM public.users u
  WHERE pp.user_id = p_user_id
    AND u.id = pp.user_id
    AND u.role = 'parent'
    AND u.deleted_at IS NULL
    AND pp.consent_granted = false;

  RETURN QUERY
  SELECT pp.consent_granted, pp.consent_granted_at
  FROM public.parent_profiles pp
  JOIN public.users u ON u.id = pp.user_id
  WHERE pp.user_id = p_user_id
    AND u.role = 'parent'
    AND u.deleted_at IS NULL;
END;
$$;

COMMENT ON FUNCTION public.record_parent_consent_trusted(uuid) IS 'Records a parent''s consent, one-way (false -> true), stamping consent_granted_at once. Returns the stored state; no row when the user has no profile or is not an active parent. Never inserts.';

REVOKE ALL ON FUNCTION public.record_parent_consent_trusted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_parent_consent_trusted(uuid) TO cartoona_app;

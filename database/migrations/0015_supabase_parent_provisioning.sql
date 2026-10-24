-- Cartoona plain-PostgreSQL (V0.1.49) - provisioning a Supabase-authenticated parent
--
-- POST /v1/auth/provision (lib/repositories/user-provisioning.ts):
--
--   SELECT public.provision_supabase_parent_identity($1)   -- $1 = verified Supabase subject
--
-- The ONE way an account that signed up AFTER the V0.1.44 data copy gets its
-- Cartoona rows. Copied (pre-cutover) accounts already have them; for those
-- this is a no-op. The target shape is exactly what the copy produces from a
-- Supabase signup (handle_new_user + parent_profiles insert + its triggers):
--
--   users            id = subject (never a new id), role 'parent', email NULL
--                    (contact data stays with the identity provider; nothing
--                    in Cartoona's PostgreSQL reads it), sessions_not_before NULL
--   user_identities  ('supabase', subject), id = md5('cartoona-identity:supabase:'
--                    || subject)::uuid - the copy tool's deterministic id
--   parent_profiles  one row, full_name NULL (signup collects no name), consent
--                    false; the existing triggers then add, in this transaction:
--                      assign_parent_referral_code      server-generated code
--                      ensure_parent_candy_wallet       one zero-balance wallet
--                      grant_parent_welcome_image_credits  one 3-credit grant
--
-- The only input is the subject, which the backend takes from a verified
-- assertion. The role is fixed here ('parent'); no user id, profile id, name,
-- balance, credit amount or referral code can be supplied.
--
-- Outcome (a word, never an exception for an expected case; nothing is written
-- for the refusals because every check runs before the first write):
--   created              new user + identity + profile (+ trigger defaults)
--   existing             everything was already there: no write at all
--   profile_created      linked parent without a profile (e.g. a Supabase
--                        signup whose profile step failed): profile added
--   identity_backfilled  user row with id = subject, NO identity of any
--                        provider, role parent: the one provably safe backfill
--                        (users.id was the Supabase auth id by construction)
--   identity_conflict    the subject is linked to another user, the user is
--                        linked to a different Supabase subject, or the user
--                        has only other-provider identities. Never remapped.
--   account_deleted      soft-deleted user: never revived
--   not_parent           admin / super_admin: never given a parent profile,
--                        never demoted
--
-- Concurrency: one transaction-scoped advisory lock per subject serializes
-- callers for the same account (users.id = subject, so it also covers the
-- user side). Each statement below runs after the lock with a fresh snapshot
-- (READ COMMITTED, VOLATILE function), so a waiter sees the winner's rows and
-- returns 'existing': no unique violation reaches the caller. Different
-- subjects do not block each other (a hash collision only serializes them).
--
-- Atomicity: one function call = one statement = one transaction. If any
-- insert or trigger fails, nothing of the account remains.
--
-- Privilege: cartoona_app gets EXECUTE on this function and nothing else. It
-- still cannot INSERT users / user_identities / parent_profiles / candy_wallets
-- / parent_welcome_credits or UPDATE users.role. SECURITY DEFINER with an
-- empty search_path, like the other *_trusted functions.

CREATE FUNCTION public.provision_supabase_parent_identity(p_subject uuid)
    RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_subject text;
  v_linked_user uuid;
  v_role text;
  v_deleted_at timestamp with time zone;
  v_outcome text := 'existing';
BEGIN
  IF p_subject IS NULL THEN
    RAISE EXCEPTION 'invalid subject' USING ERRCODE = '22023';
  END IF;
  -- uuid::text is the canonical lowercase form, the same text the copy tool
  -- stores and the backend's subject check accepts.
  v_subject := p_subject::text;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('cartoona.provision_supabase_parent_identity'),
    pg_catalog.hashtext(v_subject));

  SELECT ui.user_id INTO v_linked_user
  FROM public.user_identities ui
  WHERE ui.provider = 'supabase' AND ui.provider_subject = v_subject;

  IF v_linked_user IS NOT NULL AND v_linked_user <> p_subject THEN
    RETURN 'identity_conflict';
  END IF;

  SELECT u.role, u.deleted_at INTO v_role, v_deleted_at
  FROM public.users u
  WHERE u.id = p_subject
  FOR UPDATE;

  IF FOUND THEN
    IF v_deleted_at IS NOT NULL THEN
      RETURN 'account_deleted';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.user_identities ui
      WHERE ui.user_id = p_subject AND ui.provider = 'supabase' AND ui.provider_subject <> v_subject
    ) THEN
      RETURN 'identity_conflict';
    END IF;
    IF v_role <> 'parent' THEN
      RETURN 'not_parent';
    END IF;
    IF v_linked_user IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.user_identities ui WHERE ui.user_id = p_subject) THEN
        RETURN 'identity_conflict';
      END IF;
      INSERT INTO public.user_identities (id, user_id, provider, provider_subject, created_at)
      SELECT pg_catalog.md5('cartoona-identity:supabase:' || v_subject)::uuid, p_subject, 'supabase', v_subject, u.created_at
      FROM public.users u WHERE u.id = p_subject;
      v_outcome := 'identity_backfilled';
    END IF;
  ELSE
    INSERT INTO public.users (id, email, role) VALUES (p_subject, NULL, 'parent');
    INSERT INTO public.user_identities (id, user_id, provider, provider_subject, created_at)
    SELECT pg_catalog.md5('cartoona-identity:supabase:' || v_subject)::uuid, p_subject, 'supabase', v_subject, u.created_at
    FROM public.users u WHERE u.id = p_subject;
    v_outcome := 'created';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parent_profiles pp WHERE pp.user_id = p_subject) THEN
    -- referral_code (NOT NULL) is set by the BEFORE INSERT trigger, which
    -- runs before the constraint check - the same insert Supabase signup does.
    INSERT INTO public.parent_profiles (user_id) VALUES (p_subject);
    IF v_outcome = 'existing' THEN
      v_outcome := 'profile_created';
    END IF;
  END IF;

  RETURN v_outcome;
END;
$$;

COMMENT ON FUNCTION public.provision_supabase_parent_identity(uuid) IS 'Ensures the Cartoona parent account for one verified Supabase subject (users.id = subject, identity, profile + trigger defaults) in one transaction. Idempotent and serialized per subject. Returns created / existing / profile_created / identity_backfilled, or refuses with identity_conflict / account_deleted / not_parent without writing.';

REVOKE ALL ON FUNCTION public.provision_supabase_parent_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_supabase_parent_identity(uuid) TO cartoona_app;

-- Migration: optional_parent_full_name
-- Makes public.parent_profiles.full_name nullable so a parent account can be
-- created from a phone number and an SMS code alone.
--
-- Background:
--   Signup previously collected a name, a password and a phone number. The
--   product contract is now phone + OTP only, so there is no name to store at
--   the moment the profile row is created. The column stayed NOT NULL, which
--   made a phone-only signup impossible to complete: ensure-parent-profile,
--   complete-signup and parent-consent all had to invent a name or fail.
--
-- What this does NOT do:
--   * No existing name is rewritten, trimmed or cleared. Every parent who has
--     a name keeps exactly the name they have.
--   * No placeholder ("والد", "کاربر جدید", "بدون نام") is written anywhere.
--     A parent without a name stores NULL, and the account UI already falls
--     back to "حساب والد" at display time.
--   * No default is added, so the absence of a name stays explicit.
--
-- Reversible: the constraint can be restored once every row has a name. It is
-- not restored here because new rows are expected to be NULL by design.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Drop the NOT NULL constraint
--    Mirrors 20260712090005_allow_phone_only_auth_users.sql, which made
--    public.users.email nullable for exactly the same reason: a phone-first
--    identity has no value to put in a column that assumed an email-first one.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.parent_profiles
  ALTER COLUMN full_name DROP NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Keep whitespace-only names out
--    Dropping NOT NULL must not turn "" or "   " into an acceptable name. A
--    name is either absent (NULL) or real; there is no third state.
--    Existing rows are checked as-is — this fails loudly rather than silently
--    if any row already holds a blank name.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'parent_profiles_full_name_check'
  ) THEN
    ALTER TABLE public.parent_profiles
      ADD CONSTRAINT parent_profiles_full_name_check
        CHECK (full_name IS NULL OR char_length(btrim(full_name)) > 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.parent_profiles.full_name
  IS 'Optional parent display name. NULL for accounts created through the '
     'phone + OTP signup, which never asks for one. Never a placeholder: the '
     'UI falls back to "حساب والد" when this is NULL.';

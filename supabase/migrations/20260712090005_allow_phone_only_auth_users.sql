-- Migration: 00005_allow_phone_only_auth_users
-- Makes public.users.email nullable to support phone-only Supabase Auth accounts.
--
-- Background:
-- Phone-only signup (phone + password, no email) creates auth.users rows where
-- auth.users.email is NULL. The handle_new_user trigger (migration 00001) inserts
-- NEW.email into public.users.email, which causes a NOT NULL constraint violation.
--
-- By dropping the NOT NULL constraint:
--   - Phone-only users get public.users.email = NULL (acceptable — phone is the
--     primary identifier on auth.users)
--   - Email-based accounts continue to work unchanged
--   - The existing trigger (INSERT INTO public.users (id, email, role) VALUES
--     (NEW.id, NEW.email, 'parent')) succeeds for both phone-only and email-based
--     signups without any trigger changes
--
-- Preserves:
--   - The email column itself
--   - All existing data
--   - All foreign keys, roles, the handle_new_user trigger, and existing RLS policies
--   - No UNIQUE constraint on email (removed in migration 00001 — auth.users.email
--     enforces uniqueness)

ALTER TABLE public.users
  ALTER COLUMN email DROP NOT NULL;

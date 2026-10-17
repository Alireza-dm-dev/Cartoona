-- Cartoona plain-PostgreSQL (V0.1.43) - Cartoona-owned forced session invalidation
--
-- Replaces Cartoona's dependency on Supabase's internal session table. Every
-- verified session whose sign-in time is EARLIER than this instant is invalid;
-- NULL means no forced invalidation. Setting it to now() signs a user out of
-- every device at once (security reset, password change, "log out everywhere").
--
-- The backend reads it during identity resolution (cartoona_app already has
-- SELECT on public.users, 0009). No write privilege is granted here: the future
-- invalidation operation arrives with its own trusted, audited function.
-- Existing and copied users start NULL, which keeps every current session
-- that also satisfies the 30-day absolute lifetime.

ALTER TABLE public.users ADD COLUMN sessions_not_before timestamp with time zone;

COMMENT ON COLUMN public.users.sessions_not_before IS
  'Forced invalidation: a session that authenticated before this instant (rounded up to the second) is invalid. NULL = none. Written only by a trusted invalidation operation, never by cartoona_app directly.';

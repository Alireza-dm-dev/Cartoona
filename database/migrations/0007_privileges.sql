-- Cartoona plain-PostgreSQL baseline (V0.1.38) - privileges
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- No Supabase database roles exist here, and none are needed.
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default; for
-- SECURITY DEFINER functions that would let any login role act as the owner.
-- Revoke it, for existing and future functions. The application role and its
-- grants are introduced with the data-access layer (V0.1.39); see
-- docs/PLAIN_POSTGRES.md, "Grants to reintroduce".
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

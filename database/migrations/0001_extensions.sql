-- Cartoona plain-PostgreSQL baseline (V0.1.38) - extensions
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- gen_random_uuid() is core PostgreSQL (13+). pgcrypto supplies
-- gen_random_bytes() for referral codes. Installed in public: there is no
-- Supabase-style "extensions" schema in this baseline.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

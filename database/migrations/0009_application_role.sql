-- Cartoona plain-PostgreSQL (V0.1.39) - application role
--
-- `cartoona_app` is the privilege set the application uses. It is a NOLOGIN
-- group role: it holds the grants, nobody connects as it directly. Login roles
-- are separate members of it, created per environment by
-- scripts/db/app-login-role.sh with a password from the environment - never
-- from SQL, so no secret is ever committed or recorded in schema_migrations.
--
-- Least privilege, granted per domain as each one moves to PostgreSQL:
--  - USAGE on schema public; never CREATE, never ownership. Migrations run as
--    the owner, not as this role, so the app cannot ALTER or DROP anything.
--  - SELECT on exactly the tables the V0.1.39 read repositories query.
--  - No INSERT/UPDATE/DELETE and no EXECUTE yet: write traffic still goes to
--    Supabase. Each write cutover adds EXECUTE on the *_trusted functions it
--    calls (and only those) in a new migration.
--  - No BYPASSRLS, SUPERUSER, CREATEDB, CREATEROLE or REPLICATION. Without
--    superuser it cannot set session_replication_role, so the append-only and
--    integrity triggers stay in force for it.
--
-- Roles are cluster-wide, so creation is idempotent: several databases in one
-- cluster (tests, local copies) share the role and each grants its own tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cartoona_app') THEN
    CREATE ROLE cartoona_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Re-assert the attributes even if the role pre-existed with others.
ALTER ROLE cartoona_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cartoona_app', current_database());
END
$$;

-- PostgreSQL 15+ no longer grants CREATE on public to PUBLIC; state it anyway.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO cartoona_app;

GRANT SELECT ON
  public.users,
  public.parent_profiles,
  public.creation_pricing,
  public.parent_welcome_credits,
  public.candy_wallets,
  public.orders,
  public.order_status_history
TO cartoona_app;

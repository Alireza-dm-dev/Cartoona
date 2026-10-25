-- Create (or re-password) the application's LOGIN role on a MANAGED / REMOTE
-- PostgreSQL (V0.1.54). scripts/db/app-login-role.sh does the same for the local
-- container and refuses any non-local host by design; this file is the audited
-- equivalent an operator runs from a trusted machine against production.
--
--   export CARTOONA_APP_DB_PASSWORD="$(openssl rand -hex 32)"     # never commit, never echo
--   psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v role=cartoona_app_login \
--        -f database/ops/create-app-login-role.sql
--
-- A refusal prints one line and fails the run (non-zero exit with ON_ERROR_STOP).
--
-- Run it AFTER every file in database/migrations/ has been applied (the group
-- role cartoona_app comes from 0009) and as the schema OWNER or a role allowed to
-- CREATE ROLE. The password is read from the environment by psql itself (\getenv),
-- so it is not on any command line; put the same value into the backend's
-- DATABASE_URL in your secret store. Then verify with the checks at the bottom.
\getenv app_pw CARTOONA_APP_DB_PASSWORD
\if :{?app_pw}
\else
  \echo 'CARTOONA_APP_DB_PASSWORD is not set'
  DO $$ BEGIN RAISE EXCEPTION 'create-app-login-role refused'; END $$;
\endif
\if :{?role}
\else
  \set role cartoona_app_login
\endif
SELECT (:'role' ~ '^cartoona_app_[a-z0-9_]{1,40}$') AS role_ok,
       (length(:'app_pw') BETWEEN 24 AND 128 AND :'app_pw' ~ '^[A-Za-z0-9._~+/=-]+$') AS pw_ok \gset
\if :role_ok
\else
  \echo 'role must match cartoona_app_<lower_snake>'
  DO $$ BEGIN RAISE EXCEPTION 'create-app-login-role refused'; END $$;
\endif
\if :pw_ok
\else
  \echo 'password must be 24-128 characters of [A-Za-z0-9._~+/=-]'
  DO $$ BEGIN RAISE EXCEPTION 'create-app-login-role refused'; END $$;
\endif

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartoona_app') AS group_exists \gset
\if :group_exists
\else
  \echo 'group role cartoona_app is missing: apply database/migrations first'
  DO $$ BEGIN RAISE EXCEPTION 'create-app-login-role refused'; END $$;
\endif

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') AS login_exists \gset
\if :login_exists
  ALTER ROLE :"role" WITH LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
\else
  CREATE ROLE :"role" WITH LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
\endif
GRANT cartoona_app TO :"role";

-- Verification: every column must read as shown. Nothing here prints the password.
SELECT r.rolname,
       r.rolcanlogin AS can_login,                       -- t
       r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication AS privileged,  -- f
       pg_has_role(r.oid, 'cartoona_app', 'MEMBER') AS in_app_group,   -- t
       NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owns_nothing   -- t
FROM pg_roles r WHERE r.rolname = :'role';

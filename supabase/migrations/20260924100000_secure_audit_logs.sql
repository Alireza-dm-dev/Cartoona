-- =============================================================================
-- Migration: secure_audit_logs
-- Brings public.audit_logs under row level security.
--
-- Root cause:
--   The table was created in 20260712080000_base_schema.sql §AUDIT LOGS with
--   the literal comment `-- TODO: Add RLS — admin write/read only.` and that
--   TODO was never done. No migration ever ran ENABLE ROW LEVEL SECURITY on
--   it, and no GRANT/REVOKE was ever issued for it either, so it fell back to
--   the default public-schema privileges Supabase hands to `anon` and
--   `authenticated`. With RLS off and those grants in place, any signed-in
--   parent could read the whole table and insert fabricated rows.
--
--   This was latent while the table was empty — 20260727123000 even asserts
--   it is empty before proceeding. It stopped being latent in V0.1.18, which
--   added the first and only writer: lib/audit/final-media-audit.ts records
--   final_media_view / final_media_download against every parent deliverable
--   access. That is exactly the cross-customer access trail that must not be
--   readable or forgeable by a customer.
--
-- Model (mirrors the order_status_history lockdown in
-- 20260801120000_request_fulfilment_workflow.sql §1):
--   - RLS on, and deliberately NO policies. Under RLS a table with no
--     policy denies every row to every non-bypassing role, which is the
--     correct posture here: there is no proven use case for direct browser
--     access. Verified before writing this: the ONLY code path touching
--     audit_logs is lib/audit/final-media-audit.ts:32, which writes through
--     createAdminSupabaseClient() (service role, `import "server-only"`).
--     There is no reader anywhere in app/, lib/ or components/, and no admin
--     UI surfaces it.
--   - service_role bypasses RLS by definition, so the existing writer keeps
--     working untouched. No policy is needed to preserve it, and adding one
--     would only widen the surface.
--   - REVOKE from anon/authenticated as well as enabling RLS. Belt and
--     braces: RLS alone already denies, but removing the grants means a
--     future accidental permissive policy still cannot be reached without a
--     grant being re-issued deliberately.
--
-- Non-destructive: no row is read, written, moved or deleted; no column,
-- type or default changes. Existing rows are preserved exactly.
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op when already enabled, and
-- REVOKE is a no-op when the privilege is already absent. Safe to re-run.
-- =============================================================================

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.audit_logs FROM anon;
REVOKE ALL ON public.audit_logs FROM authenticated;

COMMENT ON TABLE public.audit_logs IS
  'Immutable audit trail for sensitive operations. RLS is enabled with no '
  'policies: browser roles (anon, authenticated) have neither grants nor a '
  'policy, so the table is unreachable from any client session. Writes come '
  'only from the server through the service-role client, which bypasses RLS '
  '(see lib/audit/final-media-audit.ts). Any future admin-facing read must '
  'go through a SECURITY DEFINER function that checks the caller''s role, '
  'not through a direct grant on this table.';

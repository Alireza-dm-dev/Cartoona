-- Supabase Storage lockdown (V0.1.54). Run on the SUPABASE project, by the
-- operator, only AFTER the irreversible boundary of the cutover (see
-- docs/PRODUCTION_CUTOVER.md): it is deliberately NOT part of supabase/migrations
-- (it must not run in the historical source chain) and NOT part of
-- database/migrations (PostgreSQL has no storage schema).
--
-- Why: the Storage policies below decide access by calling the Supabase-database
-- functions public.is_admin() / is_parent() / is_parent_approved_final_deliverable(),
-- which read the Supabase copy of public.users / orders. After the cutover that
-- copy is stale (new accounts are not in it; a role or deletion changed in
-- PostgreSQL never reaches it), and the application no longer uses these paths at
-- all: every object is read, written, copied, removed and signed server-side with
-- the service credential after PostgreSQL authorized it. Leaving the policies in
-- place would keep a browser-reachable path (anon key + any Supabase session ->
-- Storage REST API) whose authorization silently rots. Dropping them makes
-- the private buckets service-credential-only.
--
-- Kept on purpose: the two PUBLIC-read policies (example_media_select_public,
-- homepage_media_select_public): those buckets serve public URLs.
-- Rollback = re-apply the CREATE POLICY statements of the migrations named beside
-- each group (supabase/migrations/*), which exist unchanged in this repository.
-- Idempotent.
BEGIN;

-- parent-uploads            (20260717210000_private_media_storage.sql)
DROP POLICY IF EXISTS parent_uploads_insert_own ON storage.objects;
DROP POLICY IF EXISTS parent_uploads_select_own ON storage.objects;
DROP POLICY IF EXISTS parent_uploads_delete_own ON storage.objects;
DROP POLICY IF EXISTS parent_uploads_select_admin ON storage.objects;

-- generated-media           (20260717210000_private_media_storage.sql; no runtime use)
DROP POLICY IF EXISTS generated_media_insert_admin ON storage.objects;
DROP POLICY IF EXISTS generated_media_select_admin ON storage.objects;
DROP POLICY IF EXISTS generated_media_update_admin ON storage.objects;
DROP POLICY IF EXISTS generated_media_delete_admin ON storage.objects;
DROP POLICY IF EXISTS generated_media_select_parent ON storage.objects;

-- final-deliverables        (20260801120000_request_fulfilment_workflow.sql)
DROP POLICY IF EXISTS final_deliverables_insert_admin ON storage.objects;
DROP POLICY IF EXISTS final_deliverables_select_admin ON storage.objects;
DROP POLICY IF EXISTS final_deliverables_update_admin ON storage.objects;
DROP POLICY IF EXISTS final_deliverables_delete_admin ON storage.objects;
DROP POLICY IF EXISTS final_deliverables_select_parent ON storage.objects;

-- example-media admin writes (20260717090000_examples_cms.sql); public SELECT stays
DROP POLICY IF EXISTS example_media_insert_admin ON storage.objects;
DROP POLICY IF EXISTS example_media_update_admin ON storage.objects;
DROP POLICY IF EXISTS example_media_delete_admin ON storage.objects;

COMMIT;

-- Check (expect only the two public-read policies for these buckets):
--   SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
--     AND (policyname LIKE 'parent_uploads_%' OR policyname LIKE 'generated_media_%'
--          OR policyname LIKE 'final_deliverables_%' OR policyname LIKE 'example_media_%'
--          OR policyname LIKE 'homepage_media_%') ORDER BY 1;

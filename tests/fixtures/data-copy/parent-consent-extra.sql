-- Extra SOURCE rows for the V0.1.48 consent cutover test, applied after
-- supabase-source-fixture.sql and parent-account-extra.sql to the same
-- throwaway LOCAL Supabase-shaped database. Never run against a hosted project.
--
-- Every earlier fixture parent has consented. These two have NOT (consent
-- false, no time), so the copy is proven to carry both values, and the cutover
-- test has un-consented parents to walk through /parent-consent:
--   D  a1..07  un-consented, has a name
--   E  a1..08  un-consented, no name
-- Plus one consented parent whose grant time has microseconds, so "preserved
-- exactly" is checked at full timestamptz precision:
--   F  a1..09  consented at 2026-08-05 09:05:00.123456+00

BEGIN;

INSERT INTO auth.users (id, email, created_at) VALUES
  ('a1000000-0000-4000-8000-000000000007', 'parent.d@fixture.invalid', '2026-08-05 09:00:00+00'),
  ('a1000000-0000-4000-8000-000000000008', 'parent.e@fixture.invalid', '2026-08-05 09:00:00+00'),
  ('a1000000-0000-4000-8000-000000000009', 'parent.f@fixture.invalid', '2026-08-05 09:00:00+00');

UPDATE public.users SET created_at = '2026-08-05 09:00:00+00', updated_at = '2026-08-05 09:00:00+00'
WHERE id IN ('a1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000009');

INSERT INTO public.parent_profiles (id, user_id, full_name, consent_granted, consent_granted_at, created_at, updated_at) VALUES
  ('b1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000007', 'Parent D', false, NULL, '2026-08-05 09:05:00+00', '2026-08-05 09:05:00+00'),
  ('b1000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000008', NULL,       false, NULL, '2026-08-05 09:05:00+00', '2026-08-05 09:05:00+00'),
  ('b1000000-0000-4000-8000-000000000009', 'a1000000-0000-4000-8000-000000000009', 'Parent F', true, '2026-08-05 09:05:00.123456+00', '2026-08-05 09:05:00+00', '2026-08-05 09:05:00+00');

COMMIT;

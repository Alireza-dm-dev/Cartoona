-- Extra SOURCE rows for the V0.1.46 parent account-read cutover test, applied
-- after supabase-source-fixture.sql and parent-orders-extra.sql to the same
-- throwaway LOCAL Supabase-shaped database. Never run against a hosted project.
--
-- Parent C signs up through the real triggers (auth.users -> users row;
-- parent_profiles -> wallet, 3-credit welcome grant, referral code) and places
-- nothing, so C keeps all 3 welcome credits and a zero balance. Parents A and B
-- have used theirs up (parent-orders-extra.sql) and hold different balances,
-- and B has no name: every account value differs between at least two parents.

BEGIN;

INSERT INTO auth.users (id, email, created_at) VALUES
  ('a1000000-0000-4000-8000-000000000006', 'parent.c@fixture.invalid', '2026-08-04 09:00:00+00');

UPDATE public.users SET created_at = '2026-08-04 09:00:00+00', updated_at = '2026-08-04 09:00:00+00'
WHERE id = 'a1000000-0000-4000-8000-000000000006';

INSERT INTO public.parent_profiles (id, user_id, full_name, consent_granted, consent_granted_at, created_at, updated_at) VALUES
  ('b1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000006', 'پریسا احمدی', true, '2026-08-04 09:05:00+00', '2026-08-04 09:05:00+00', '2026-08-04 09:05:00+00');

COMMIT;

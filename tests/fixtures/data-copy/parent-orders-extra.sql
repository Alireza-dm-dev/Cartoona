-- Extra SOURCE orders for the V0.1.45 parent-orders cutover test, applied after
-- supabase-source-fixture.sql to the same throwaway LOCAL Supabase-shaped
-- database. Never run against a hosted project.
--
-- Parents A and B each place 25 more image orders through the real
-- create_parent_request_trusted (welcome credits are used up, so these are
-- candy-paid with ledger debits). Their created_at values OVERLAP exactly:
-- order k of A and order k of B share one timestamp, so keyset pagination is
-- exercised across two parents with identical sort keys. Some of A's are
-- delivered (with history), some in progress, one rejected.

BEGIN;

SELECT public.create_parent_request_trusted(
  p_parent_profile_id => p.profile, p_order_id => ('c2000000-0000-4000-8000-000000000' || p.tag || lpad(k::text, 2, '0'))::uuid,
  p_type => 'image', p_title => p.name || ' extra ' || k,
  p_character_id => (SELECT id FROM public.characters WHERE is_active ORDER BY name LIMIT 1),
  p_child_name => CASE WHEN k % 2 = 0 THEN 'Sara' ELSE NULL END,
  p_submission_key => ('c3000000-0000-4000-8000-000000000' || p.tag || lpad(k::text, 2, '0'))::uuid)
FROM (VALUES ('b1000000-0000-4000-8000-000000000001'::uuid, '1', 'A'), ('b1000000-0000-4000-8000-000000000002'::uuid, '2', 'B')) p(profile, tag, name)
CROSS JOIN generate_series(1, 25) k;

UPDATE public.orders
SET created_at = '2026-10-01 10:00:00.000001+00'::timestamptz + (right(id::text, 2)::int * interval '1 minute'),
    updated_at = '2026-10-01 10:00:00.000001+00'::timestamptz + (right(id::text, 2)::int * interval '1 minute')
WHERE id::text LIKE 'c2000000-%';

-- A: every 5th extra order delivered (in_progress -> delivered), every 7th in progress, #13 rejected.
INSERT INTO public.order_status_history (id, order_id, previous_status, new_status, changed_by_user_id, created_at)
SELECT ('c4000000-0000-4000-8000-0000000001' || lpad(k::text, 2, '0'))::uuid, ('c2000000-0000-4000-8000-0000000001' || lpad(k::text, 2, '0'))::uuid,
       'pending_review', 'in_progress', 'a1000000-0000-4000-8000-000000000003', '2026-10-02 08:00:00+00'::timestamptz + k * interval '1 minute'
FROM generate_series(1, 25) k WHERE k % 5 = 0 OR k % 7 = 0;
INSERT INTO public.order_status_history (id, order_id, previous_status, new_status, changed_by_user_id, parent_visible_note, created_at)
SELECT ('c5000000-0000-4000-8000-0000000001' || lpad(k::text, 2, '0'))::uuid, ('c2000000-0000-4000-8000-0000000001' || lpad(k::text, 2, '0'))::uuid,
       'in_progress', 'delivered', 'a1000000-0000-4000-8000-000000000003', 'Done', '2026-10-03 09:00:00.123456+00'::timestamptz + k * interval '1 minute'
FROM generate_series(1, 25) k WHERE k % 5 = 0;
UPDATE public.orders SET status = 'delivered' WHERE id::text LIKE 'c2000000-0000-4000-8000-0000000001%' AND right(id::text, 2)::int % 5 = 0;
UPDATE public.orders SET status = 'in_progress' WHERE id::text LIKE 'c2000000-0000-4000-8000-0000000001%' AND right(id::text, 2)::int % 7 = 0 AND right(id::text, 2)::int % 5 <> 0;
INSERT INTO public.order_status_history (id, order_id, previous_status, new_status, changed_by_user_id, internal_note, created_at)
VALUES ('c6000000-0000-4000-8000-000000000113', 'c2000000-0000-4000-8000-000000000113', 'pending_review', 'rejected', 'a1000000-0000-4000-8000-000000000003', 'not suitable', '2026-10-02 12:00:00+00');
UPDATE public.orders SET status = 'rejected' WHERE id = 'c2000000-0000-4000-8000-000000000113';

COMMIT;

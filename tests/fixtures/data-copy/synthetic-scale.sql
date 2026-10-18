-- Scaled SYNTHETIC source for the V0.1.44 data-copy timing test (opt-in).
-- Applied as the owner to a throwaway LOCAL Supabase-shaped database
-- (stub + real supabase/migrations chain). Never run against a hosted project.
--
-- Shape (defaults): 1,000 users (990 parents, 10 admins, 20 parents soft-
-- deleted), ~10,000 orders, ~2,000 paid purchases with attempts, ~8,000 ledger
-- rows, ~16,000 status-history rows, ~6,000 media rows, 3,000 audit rows. Every
-- row satisfies the copy tool's reconciliation rules: balance = signed ledger
-- sum, used_count = usages, one debit per candy order, one credit per paid
-- purchase. Ids are deterministic (md5 of a label).

BEGIN;
SET LOCAL synth.parents = '990';
SET LOCAL synth.admins = '10';

INSERT INTO auth.users (id, email, created_at)
SELECT md5('user:' || n)::uuid, 'u' || n || '@synthetic.invalid', '2026-07-01 00:00:00+00'::timestamptz + n * interval '1 minute'
FROM generate_series(1, current_setting('synth.parents')::int + current_setting('synth.admins')::int) n;
UPDATE public.users u SET created_at = a.created_at, updated_at = a.created_at FROM auth.users a WHERE a.id = u.id;
UPDATE public.users SET role = 'admin' WHERE id IN (SELECT md5('user:' || n)::uuid FROM generate_series(current_setting('synth.parents')::int + 1, current_setting('synth.parents')::int + current_setting('synth.admins')::int) n);

-- Profiles through the real triggers (wallet, welcome grant, referral code).
INSERT INTO public.parent_profiles (id, user_id, full_name, consent_granted, consent_granted_at, created_at, updated_at)
SELECT md5('profile:' || n)::uuid, md5('user:' || n)::uuid, 'Parent ' || n, true, '2026-07-02 00:00:00+00', '2026-07-02 00:00:00+00', '2026-07-02 00:00:00+00'
FROM generate_series(1, current_setting('synth.parents')::int) n;

-- Two paid purchases per parent: purchase + verified attempt + ledger credit.
INSERT INTO public.candy_purchases (id, parent_id, package_id, candy_amount, price_amount, original_price_amount, discount_amount, final_price_amount, currency, status, paid_at, payment_provider, created_at)
SELECT md5('purchase:' || p.id || ':' || k)::uuid, p.id, pk.id, 200, pk.price_amount, pk.price_amount, 0, pk.price_amount, pk.currency, 'paid',
       '2026-07-03 00:00:00+00'::timestamptz + k * interval '1 hour', 'simulation', '2026-07-03 00:00:00+00'::timestamptz + k * interval '1 hour'
FROM public.parent_profiles p CROSS JOIN generate_series(1, 2) k
CROSS JOIN LATERAL (SELECT id, price_amount, currency FROM public.candy_packages ORDER BY candy_amount DESC LIMIT 1) pk;
INSERT INTO public.payment_attempts (id, purchase_id, provider, status, requested_amount, requested_currency, verified_amount, verified_currency, provider_verified_at, attempt_number, idempotency_key, completed_at)
SELECT md5('attempt:' || id)::uuid, id, 'simulation', 'verified', final_price_amount, currency, final_price_amount, currency, paid_at, 1, 'attempt:' || id, paid_at
FROM public.candy_purchases;
UPDATE public.candy_purchases SET active_payment_attempt_id = md5('attempt:' || id)::uuid;
INSERT INTO public.candy_transactions (id, wallet_id, amount, type, reference_type, reference_id, description, idempotency_key, created_at)
SELECT md5('credit:' || cp.id)::uuid, w.id, cp.candy_amount, 'purchase', 'candy_purchase', cp.id::text, 'synthetic credit', 'purchase_credit:' || cp.id, cp.paid_at
FROM public.candy_purchases cp JOIN public.candy_wallets w ON w.parent_id = cp.parent_id;

-- ~10 orders per parent (+1 for the first 100): 3 welcome-credit images, then candy image/video/drawing.
CREATE TEMP TABLE synth_orders AS
SELECT md5('order:' || p.id || ':' || k)::uuid AS id, p.id AS parent_id, p.user_id, k,
       CASE WHEN k <= 3 THEN 'image' WHEN k % 3 = 0 THEN 'image' WHEN k % 3 = 1 THEN 'video' ELSE 'drawing_animation' END AS type,
       CASE WHEN k <= 3 THEN 'welcome_image_credit' ELSE 'candy' END AS payment_source,
       '2026-08-01 00:00:00+00'::timestamptz + (k * interval '1 day') + ((hashtext(p.id::text) & 1023) * interval '1 second') + interval '0.000001 second' * k AS created_at
FROM public.parent_profiles p
CROSS JOIN LATERAL generate_series(1, CASE WHEN p.id IN (SELECT md5('profile:' || n)::uuid FROM generate_series(1, 100) n) THEN 11 ELSE 10 END) k;

INSERT INTO public.orders (id, parent_id, type, status, title, description, character_id, candy_cost, created_at, updated_at, child_name, submission_key, payment_source)
SELECT o.id, o.parent_id, o.type, CASE WHEN o.k % 3 = 1 THEN 'delivered' ELSE 'in_progress' END, 'Order ' || o.k, '',
       CASE WHEN o.type = 'drawing_animation' THEN NULL ELSE (SELECT id FROM public.characters WHERE is_active ORDER BY name LIMIT 1) END,
       CASE WHEN o.payment_source = 'welcome_image_credit' THEN 0 WHEN o.type = 'image' THEN 10 WHEN o.type = 'video' THEN 40 ELSE 35 END,
       o.created_at, o.created_at, 'Child ' || (o.k % 5), md5('submission:' || o.id)::uuid, o.payment_source
FROM synth_orders o;

INSERT INTO public.parent_welcome_credit_usages (id, parent_id, order_id, created_at)
SELECT md5('usage:' || id)::uuid, parent_id, id, created_at FROM synth_orders WHERE payment_source = 'welcome_image_credit';
UPDATE public.parent_welcome_credits c SET used_count = u.n FROM (SELECT parent_id, count(*) AS n FROM public.parent_welcome_credit_usages GROUP BY parent_id) u WHERE u.parent_id = c.parent_id;

INSERT INTO public.candy_transactions (id, wallet_id, amount, type, reference_type, reference_id, description, idempotency_key, created_at)
SELECT md5('debit:' || o.id)::uuid, w.id, -o.candy_cost, 'order_debit', 'order', o.id::text, 'synthetic debit', 'order_debit:' || o.id, o.created_at
FROM public.orders o JOIN public.candy_wallets w ON w.parent_id = o.parent_id WHERE o.payment_source = 'candy';
UPDATE public.candy_wallets w SET balance = s.total FROM (SELECT wallet_id, sum(amount) AS total FROM public.candy_transactions GROUP BY wallet_id) s WHERE s.wallet_id = w.id;

INSERT INTO public.video_requests (id, order_id, script, duration_choice, characters_speak)
SELECT md5('video:' || id)::uuid, id, 'script', '5_10', false FROM synth_orders WHERE type = 'video';
INSERT INTO public.drawing_animation_requests (id, order_id, upload_url, animation_style)
SELECT md5('anim:' || id)::uuid, id, user_id || '/' || id || '/drawing.png', 'wave' FROM synth_orders WHERE type = 'drawing_animation';

-- History: every order gets in_progress; delivered ones get ready + delivered too.
INSERT INTO public.order_status_history (id, order_id, previous_status, new_status, changed_by_user_id, created_at)
SELECT md5('h1:' || id)::uuid, id, 'pending_review', 'in_progress', md5('user:' || (current_setting('synth.parents')::int + 1))::uuid, created_at + interval '1 hour' FROM synth_orders;
INSERT INTO public.order_status_history (id, order_id, previous_status, new_status, changed_by_user_id, created_at)
SELECT md5('h' || s.n || ':' || o.id)::uuid, o.id, CASE s.n WHEN 2 THEN 'in_progress' ELSE 'ready' END, CASE s.n WHEN 2 THEN 'ready' ELSE 'delivered' END,
       md5('user:' || (current_setting('synth.parents')::int + 1))::uuid, o.created_at + s.n * interval '1 hour' + interval '0.123456 second'
FROM synth_orders o CROSS JOIN (VALUES (2), (3)) s(n) WHERE o.k % 3 = 1;

-- Media: uploads for drawings, approved finals for delivered orders.
INSERT INTO public.media_assets (id, order_id, type, asset_role, file_url, mime_type, byte_size, original_filename, uploaded_by_user_id, created_at)
SELECT md5('src:' || id)::uuid, id, 'upload', 'source', user_id || '/' || id || '/drawing.png', 'image/png', 20000 + k, 'drawing.png', user_id, created_at FROM synth_orders WHERE type = 'drawing_animation';
INSERT INTO public.media_assets (id, order_id, type, asset_role, delivery_status, file_url, mime_type, byte_size, parent_visible, moderation_status, uploaded_by_user_id, created_at)
SELECT md5('final:' || id)::uuid, id, 'generated', 'final', 'approved', 'orders/' || id || '/final/result.png', 'image/png', 900000 + k, true, 'passed',
       md5('user:' || (current_setting('synth.parents')::int + 1))::uuid, created_at + interval '2 hours'
FROM synth_orders WHERE k % 3 = 1;

INSERT INTO public.audit_logs (id, actor_id, action, target_type, target_id, metadata, created_at)
SELECT md5('audit:' || n)::uuid, md5('user:' || (current_setting('synth.parents')::int + 1))::uuid, 'order.status_changed', 'order', md5('order:' || n)::uuid, jsonb_build_object('n', n), '2026-09-01 00:00:00+00'::timestamptz + n * interval '1 second'
FROM generate_series(1, 3000) n;

UPDATE public.users SET deleted_at = '2026-09-15 00:00:00+00' WHERE id IN (SELECT md5('user:' || n)::uuid FROM generate_series(1, 20) n);
COMMIT;

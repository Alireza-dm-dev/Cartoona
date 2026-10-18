-- Realistic Supabase-shaped SOURCE fixture for the V0.1.44 data-copy tests.
--
-- Applied by tests/unit/data-copy-db.test.ts, as the owner, to a throwaway
-- LOCAL database built from tests/helpers/supabase-stub.sql + supabase/migrations
-- (the real historical chain). Never run against a hosted project.
--
-- Rows come from the real paths wherever the chain has them: auth.users ->
-- handle_new_user, parent_profiles -> wallet/welcome-grant/referral-code
-- triggers, complete_candy_purchase_trusted (ledger credit), and
-- create_parent_request_trusted (welcome credit first, candy fallback,
-- drawing upload checked against storage.objects). Fulfilment history, final
-- media and CMS/admin edits are direct writes, with fixed timestamps.
--
-- Primary ids are deterministic. Ids the triggers generate (wallets) are set
-- to fixed values before anything references them; ledger rows keep the ids
-- the business functions gave them.

BEGIN;

-- ── accounts ────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, created_at) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'parent.a@fixture.invalid', '2026-08-01 09:00:00.111111+00'),
  ('a1000000-0000-4000-8000-000000000002', 'parent.b@fixture.invalid', '2026-08-02 09:00:00.222222+00'),
  ('a1000000-0000-4000-8000-000000000003', 'admin@fixture.invalid',    '2026-07-15 09:00:00+00'),
  ('a1000000-0000-4000-8000-000000000004', 'deleted@fixture.invalid',  '2026-08-03 09:00:00+00'),
  ('a1000000-0000-4000-8000-000000000005', 'super@fixture.invalid',    '2026-07-10 09:00:00+00');

UPDATE public.users u SET created_at = a.created_at, updated_at = a.created_at FROM auth.users a WHERE a.id = u.id;
UPDATE public.users SET role = 'admin' WHERE id = 'a1000000-0000-4000-8000-000000000003';
UPDATE public.users SET role = 'super_admin' WHERE id = 'a1000000-0000-4000-8000-000000000005';

INSERT INTO public.parent_profiles (id, user_id, full_name, consent_granted, consent_granted_at, created_at, updated_at) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Parent A', true, '2026-08-01 09:05:00+00', '2026-08-01 09:05:00+00', '2026-08-01 09:05:00+00'),
  ('b1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', NULL,       true, '2026-08-02 09:05:00+00', '2026-08-02 09:05:00+00', '2026-08-02 09:05:00+00'),
  ('b1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000004', 'Deleted',  true, '2026-08-03 09:05:00+00', '2026-08-03 09:05:00+00', '2026-08-03 09:05:00+00');

-- The wallet trigger generated random ids; fix them before any ledger row points at them.
UPDATE public.candy_wallets SET id = 'c1000000-0000-4000-8000-000000000001' WHERE parent_id = 'b1000000-0000-4000-8000-000000000001';
UPDATE public.candy_wallets SET id = 'c1000000-0000-4000-8000-000000000002' WHERE parent_id = 'b1000000-0000-4000-8000-000000000002';
UPDATE public.candy_wallets SET id = 'c1000000-0000-4000-8000-000000000004' WHERE parent_id = 'b1000000-0000-4000-8000-000000000004';

INSERT INTO public.child_profiles (id, parent_id, name, birth_year, created_at, updated_at)
VALUES ('d1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Sara', 2019, '2026-08-01 10:00:00+00', '2026-08-01 10:00:00+00');

-- ── reference data edited by admins (must carry forward) ────────────────────
UPDATE public.creation_pricing SET candy_cost = candy_cost + 1, updated_at = '2026-08-20 12:00:00+00'
WHERE pricing_key = (SELECT min(pricing_key) FROM public.creation_pricing);
UPDATE public.referral_program_settings SET reward_basis_points = 2000, updated_by = 'a1000000-0000-4000-8000-000000000003' WHERE id = 1;
INSERT INTO public.referral_program_settings_history (id, actor_user_id, previous_is_enabled, new_is_enabled, previous_reward_basis_points, new_reward_basis_points, changed_at)
VALUES ('e1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', true, true, 1500, 2000, '2026-08-21 08:00:00+00');
UPDATE public.homepage_content SET content_json = content_json || '{"fixtureEdited": true}'::jsonb, revision = revision + 1, updated_by_user_id = 'a1000000-0000-4000-8000-000000000003';
INSERT INTO public.homepage_media_assets (id, slot_key, media_type, storage_path, mime_type, byte_size, width, height, updated_by_user_id)
VALUES ('e2000000-0000-4000-8000-000000000001', 'hero.background', 'image', 'homepage/hero/background.webp', 'image/webp', 48213, 1920, 1080, 'a1000000-0000-4000-8000-000000000003');
INSERT INTO public.examples (id, kind, title, description, character_id, media_url, thumbnail_url, is_published, sort_order, badge_label)
SELECT 'e3000000-0000-4000-8000-000000000001', 'video', 'Example video', 'A published example', id, 'examples/e1/video.mp4', 'examples/e1/thumb.webp', true, 1, 'New'
FROM public.characters WHERE is_active ORDER BY name LIMIT 1;

-- ── candy purchases (real completion path) + coupon ─────────────────────────
INSERT INTO public.coupons (id, code, name, discount_type, discount_value, created_by_user_id)
VALUES ('f1000000-0000-4000-8000-000000000001', 'WELCOME10', 'Welcome 10%', 'percentage', 1000, 'a1000000-0000-4000-8000-000000000003');
INSERT INTO public.coupon_package_rules (coupon_id, package_id)
SELECT 'f1000000-0000-4000-8000-000000000001', id FROM public.candy_packages ORDER BY candy_amount DESC LIMIT 1;

INSERT INTO public.candy_purchases (id, parent_id, package_id, candy_amount, price_amount, original_price_amount, discount_amount, final_price_amount, currency, payment_provider)
SELECT v.id::uuid, v.parent::uuid, p.id, p.candy_amount, p.price_amount, p.price_amount, 0, p.price_amount, p.currency, 'simulation'
FROM (VALUES ('f2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'),
             ('f2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002')) v(id, parent)
CROSS JOIN LATERAL (SELECT * FROM public.candy_packages ORDER BY candy_amount DESC LIMIT 1) p;

INSERT INTO public.payment_attempts (id, purchase_id, provider, status, requested_amount, requested_currency, verified_amount, verified_currency, provider_verified_at, attempt_number, idempotency_key, completed_at)
SELECT ('f3000000-0000-4000-8000-00000000000' || right(id::text, 1))::uuid, id, 'simulation', 'verified', final_price_amount, currency, final_price_amount, currency,
       '2026-08-25 10:00:00+00', 1, 'attempt:' || id, '2026-08-25 10:00:01+00'
FROM public.candy_purchases;
UPDATE public.candy_purchases SET active_payment_attempt_id = ('f3000000-0000-4000-8000-00000000000' || right(id::text, 1))::uuid;

SELECT public.complete_candy_purchase_trusted('f2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'sim-ref-1');
SELECT public.complete_candy_purchase_trusted('f2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'sim-ref-2');

INSERT INTO public.payment_webhook_events (id, provider, provider_event_id, event_type, attempt_id, purchase_id, processing_status, processed_at)
VALUES ('f4000000-0000-4000-8000-000000000001', 'simulation', 'evt_0001', 'payment.verified', 'f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'processed', '2026-08-25 10:00:02+00');

-- A pending purchase with a reserved coupon redemption (10% off).
INSERT INTO public.candy_purchases (id, parent_id, package_id, candy_amount, price_amount, original_price_amount, discount_amount, final_price_amount, currency)
SELECT 'f2000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', p.id, p.candy_amount, p.price_amount, p.price_amount, p.price_amount / 10, p.price_amount - p.price_amount / 10, p.currency
FROM (SELECT * FROM public.candy_packages ORDER BY candy_amount DESC LIMIT 1) p;
INSERT INTO public.coupon_redemptions (id, coupon_id, purchase_id, parent_profile_id, normalized_code_snapshot, discount_type_snapshot, discount_value_snapshot,
                                       original_price_amount, discount_amount, final_price_amount, currency, status, idempotency_key)
SELECT 'f5000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', id, parent_id, 'WELCOME10', 'percentage', 1000,
       original_price_amount, discount_amount, final_price_amount, currency, 'reserved', 'redeem:' || id
FROM public.candy_purchases WHERE id = 'f2000000-0000-4000-8000-000000000003';

-- ── orders through the real request function ────────────────────────────────
-- Parent A: three images on welcome credits, a fourth image and a video on candy.
SELECT public.create_parent_request_trusted(p_parent_profile_id => 'b1000000-0000-4000-8000-000000000001', p_order_id => ('a2000000-0000-4000-8000-00000000000' || n)::uuid,
         p_type => 'image', p_title => 'Order ' || n, p_character_id => (SELECT id FROM public.characters WHERE is_active ORDER BY name LIMIT 1),
         p_child_name => 'Sara', p_submission_key => ('a3000000-0000-4000-8000-00000000000' || n)::uuid)
FROM generate_series(1, 4) n;
SELECT public.create_parent_request_trusted(p_parent_profile_id => 'b1000000-0000-4000-8000-000000000001', p_order_id => 'a2000000-0000-4000-8000-000000000005',
         p_type => 'video', p_title => 'Video', p_character_id => (SELECT id FROM public.characters WHERE is_active ORDER BY name LIMIT 1),
         p_duration_key => 'short', p_video_script => 'script', p_duration_choice => '5_10', p_characters_speak => false,
         p_submission_key => 'a3000000-0000-4000-8000-000000000005');

-- Parent B: one image on a welcome credit, one drawing animation on candy (upload verified against storage.objects).
SELECT public.create_parent_request_trusted(p_parent_profile_id => 'b1000000-0000-4000-8000-000000000002', p_order_id => 'a2000000-0000-4000-8000-000000000006',
         p_type => 'image', p_title => 'B image', p_character_id => (SELECT id FROM public.characters WHERE is_active ORDER BY name LIMIT 1),
         p_submission_key => 'a3000000-0000-4000-8000-000000000006');
INSERT INTO storage.objects (bucket_id, name, owner, metadata)
VALUES ('parent-uploads', 'a1000000-0000-4000-8000-000000000002/a2000000-0000-4000-8000-000000000007/drawing.png',
        'a1000000-0000-4000-8000-000000000002', '{"mimetype": "image/png", "size": 20480}');
SELECT public.create_parent_request_trusted(p_parent_profile_id => 'b1000000-0000-4000-8000-000000000002', p_order_id => 'a2000000-0000-4000-8000-000000000007',
         p_type => 'drawing_animation', p_title => 'Animate', p_duration_key => 'short', p_animation_style => 'wave',
         p_file_path => 'a1000000-0000-4000-8000-000000000002/a2000000-0000-4000-8000-000000000007/drawing.png',
         p_original_filename => 'drawing.png', p_submission_key => 'a3000000-0000-4000-8000-000000000007');

-- Soon-deleted parent: one delivered image on a welcome credit.
SELECT public.create_parent_request_trusted(p_parent_profile_id => 'b1000000-0000-4000-8000-000000000004', p_order_id => 'a2000000-0000-4000-8000-000000000008',
         p_type => 'image', p_title => 'Old order', p_character_id => (SELECT id FROM public.characters WHERE is_active ORDER BY name LIMIT 1),
         p_submission_key => 'a3000000-0000-4000-8000-000000000008');

-- Fixed creation times (microseconds on purpose: pagination cursors depend on them).
UPDATE public.orders SET created_at = '2026-09-01 10:00:00.000001+00'::timestamptz + (right(id::text, 1)::int * interval '1 hour'),
                         updated_at = '2026-09-01 10:00:00.000001+00'::timestamptz + (right(id::text, 1)::int * interval '1 hour');

-- ── fulfilment: history + final media ───────────────────────────────────────
INSERT INTO public.order_status_history (id, order_id, previous_status, new_status, changed_by_user_id, internal_note, parent_visible_note, created_at) VALUES
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'pending_review', 'in_progress', 'a1000000-0000-4000-8000-000000000003', 'picked up', NULL, '2026-09-02 08:00:00.100000+00'),
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'in_progress', 'ready', 'a1000000-0000-4000-8000-000000000003', NULL, NULL, '2026-09-02 09:00:00.200000+00'),
  ('a4000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'ready', 'delivered', 'a1000000-0000-4000-8000-000000000003', NULL, 'Enjoy!', '2026-09-02 10:00:00.345678+00'),
  ('a4000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000005', 'pending_review', 'in_progress', 'a1000000-0000-4000-8000-000000000005', NULL, NULL, '2026-09-03 08:00:00+00'),
  ('a4000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000008', 'pending_review', 'in_progress', 'a1000000-0000-4000-8000-000000000003', NULL, NULL, '2026-09-04 08:00:00+00'),
  ('a4000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000008', 'in_progress', 'delivered', 'a1000000-0000-4000-8000-000000000003', NULL, NULL, '2026-09-04 09:30:00.654321+00');
UPDATE public.orders SET status = 'delivered' WHERE id IN ('a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000008');
UPDATE public.orders SET status = 'in_progress' WHERE id = 'a2000000-0000-4000-8000-000000000005';

INSERT INTO public.media_assets (id, order_id, type, asset_role, delivery_status, file_url, mime_type, byte_size, original_filename, uploaded_by_user_id, superseded_at, parent_visible, moderation_status, created_at) VALUES
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'generated', 'final', 'superseded', 'orders/a2000000-0000-4000-8000-000000000001/final/v1.png', 'image/png', 1000001, 'v1.png', 'a1000000-0000-4000-8000-000000000003', '2026-09-02 08:59:00+00', false, 'passed', '2026-09-02 08:30:00+00'),
  ('a5000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'generated', 'final', 'approved',   'orders/a2000000-0000-4000-8000-000000000001/final/v2.png', 'image/png', 1000002, 'v2.png', 'a1000000-0000-4000-8000-000000000003', NULL, true, 'passed', '2026-09-02 08:59:30+00'),
  ('a5000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000008', 'generated', 'final', 'approved',   'orders/a2000000-0000-4000-8000-000000000008/final/final.webp', 'image/webp', 500000, NULL, 'a1000000-0000-4000-8000-000000000003', NULL, true, 'passed', '2026-09-04 09:00:00+00');
INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'final-deliverables', file_url, jsonb_build_object('mimetype', mime_type, 'size', byte_size) FROM public.media_assets WHERE asset_role = 'final';

-- ── referrals ───────────────────────────────────────────────────────────────
INSERT INTO public.referral_relationships (id, referred_parent_id, referrer_parent_id, referral_code_snapshot, binding_source, bound_at)
SELECT 'e4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', id, referral_code, 'signup_link', '2026-08-02 09:06:00+00'
FROM public.parent_profiles WHERE id = 'b1000000-0000-4000-8000-000000000001';
INSERT INTO public.referral_binding_rate_limits (parent_id, window_started_at, attempt_count)
VALUES ('b1000000-0000-4000-8000-000000000002', '2026-08-02 09:00:00+00', 1);

-- ── audit / moderation history ──────────────────────────────────────────────
INSERT INTO public.audit_logs (id, actor_id, action, target_type, target_id, metadata, created_at) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'order.status_changed', 'order', 'a2000000-0000-4000-8000-000000000001', '{"from": "ready", "to": "delivered"}', '2026-09-02 10:00:00.345678+00'),
  ('e5000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000005', 'coupon.created', 'coupon', 'f1000000-0000-4000-8000-000000000001', '{"code": "WELCOME10"}', '2026-08-20 11:00:00+00');
INSERT INTO public.moderation_logs (id, target_type, target_id, action, moderator_id, reason, created_at)
VALUES ('e6000000-0000-4000-8000-000000000001', 'media', 'a5000000-0000-4000-8000-000000000002', 'approved', 'a1000000-0000-4000-8000-000000000003', 'ok', '2026-09-02 09:00:00+00');

-- ── soft delete (after the history above, as in production) ─────────────────
UPDATE public.users SET deleted_at = '2026-09-10 12:00:00.5+00' WHERE id = 'a1000000-0000-4000-8000-000000000004';

COMMIT;

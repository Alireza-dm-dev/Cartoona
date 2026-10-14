-- Cartoona plain-PostgreSQL baseline (V0.1.38) - tables, keys, constraints, indexes
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- ══ Tables ══

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.candy_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    candy_amount integer NOT NULL,
    price_amount integer NOT NULL,
    currency text DEFAULT 'IRR'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT candy_packages_candy_amount_check CHECK ((candy_amount > 0)),
    CONSTRAINT candy_packages_name_check CHECK ((char_length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT candy_packages_price_amount_check CHECK ((price_amount > 0))
);

CREATE TABLE public.candy_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    package_id uuid NOT NULL,
    candy_amount integer NOT NULL,
    price_amount integer NOT NULL,
    currency text DEFAULT 'IRR'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payment_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    active_payment_attempt_id uuid,
    payment_provider text,
    provider_verified_at timestamp with time zone,
    expires_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    failed_at timestamp with time zone,
    original_price_amount integer NOT NULL,
    discount_amount integer DEFAULT 0 NOT NULL,
    final_price_amount integer NOT NULL,
    CONSTRAINT candy_purchases_candy_amount_check CHECK ((candy_amount > 0)),
    CONSTRAINT candy_purchases_discount_nonnegative_check CHECK ((discount_amount >= 0)),
    CONSTRAINT candy_purchases_final_price_nonnegative_check CHECK ((final_price_amount >= 0)),
    CONSTRAINT candy_purchases_original_price_positive_check CHECK ((original_price_amount > 0)),
    CONSTRAINT candy_purchases_price_amount_check CHECK ((price_amount > 0)),
    CONSTRAINT candy_purchases_price_snapshot_invariant_check CHECK (((original_price_amount = price_amount) AND ((original_price_amount - discount_amount) = final_price_amount))),
    CONSTRAINT candy_purchases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'cancelled'::text, 'expired'::text])))
);

CREATE TABLE public.candy_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_id uuid NOT NULL,
    amount integer NOT NULL,
    type text NOT NULL,
    reference_type text,
    reference_id text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text,
    CONSTRAINT candy_transactions_amount_check CHECK ((amount <> 0)),
    CONSTRAINT candy_transactions_type_check CHECK ((type = ANY (ARRAY['purchase'::text, 'spend'::text, 'refund'::text, 'grant'::text, 'order_debit'::text])))
);

CREATE TABLE public.candy_wallets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT candy_wallets_balance_check CHECK ((balance >= 0))
);

CREATE TABLE public.characters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    category text,
    image_url text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.child_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    name text NOT NULL,
    birth_year integer,
    favorite_character_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.coupon_package_rules (
    coupon_id uuid NOT NULL,
    package_id uuid NOT NULL
);

CREATE TABLE public.coupon_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    coupon_id uuid NOT NULL,
    purchase_id uuid NOT NULL,
    parent_profile_id uuid NOT NULL,
    normalized_code_snapshot text NOT NULL,
    discount_type_snapshot text NOT NULL,
    discount_value_snapshot integer NOT NULL,
    original_price_amount integer NOT NULL,
    discount_amount integer NOT NULL,
    final_price_amount integer NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    redeemed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT coupon_redemptions_currency_nonempty_check CHECK ((char_length(TRIM(BOTH FROM currency)) > 0)),
    CONSTRAINT coupon_redemptions_discount_nonnegative_check CHECK ((discount_amount >= 0)),
    CONSTRAINT coupon_redemptions_final_nonnegative_check CHECK ((final_price_amount >= 0)),
    CONSTRAINT coupon_redemptions_original_positive_check CHECK ((original_price_amount > 0)),
    CONSTRAINT coupon_redemptions_price_consistency_check CHECK (((original_price_amount - discount_amount) = final_price_amount)),
    CONSTRAINT coupon_redemptions_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'redeemed'::text, 'cancelled'::text]))),
    CONSTRAINT coupon_redemptions_type_check CHECK ((discount_type_snapshot = ANY (ARRAY['percentage'::text, 'fixed_amount'::text]))),
    CONSTRAINT coupon_redemptions_value_positive_check CHECK ((discount_value_snapshot > 0))
);

CREATE TABLE public.coupons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    discount_type text NOT NULL,
    discount_value integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    expires_at timestamp with time zone,
    global_usage_limit integer,
    per_parent_usage_limit integer,
    minimum_purchase_amount integer,
    maximum_discount_amount integer,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupons_code_normalized_check CHECK (((code = upper(TRIM(BOTH FROM code))) AND (code ~ '^[A-Z0-9_-]{3,32}$'::text))),
    CONSTRAINT coupons_dates_order_check CHECK (((expires_at IS NULL) OR (starts_at IS NULL) OR (expires_at > starts_at))),
    CONSTRAINT coupons_discount_type_check CHECK ((discount_type = ANY (ARRAY['percentage'::text, 'fixed_amount'::text]))),
    CONSTRAINT coupons_discount_value_check CHECK ((((discount_type = 'percentage'::text) AND ((discount_value >= 1) AND (discount_value <= 10000))) OR ((discount_type = 'fixed_amount'::text) AND (discount_value > 0)))),
    CONSTRAINT coupons_global_limit_positive_check CHECK (((global_usage_limit IS NULL) OR (global_usage_limit > 0))),
    CONSTRAINT coupons_maximum_discount_positive_check CHECK (((maximum_discount_amount IS NULL) OR (maximum_discount_amount > 0))),
    CONSTRAINT coupons_minimum_amount_nonnegative_check CHECK (((minimum_purchase_amount IS NULL) OR (minimum_purchase_amount >= 0))),
    CONSTRAINT coupons_name_nonempty_check CHECK ((char_length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT coupons_parent_limit_positive_check CHECK (((per_parent_usage_limit IS NULL) OR (per_parent_usage_limit > 0)))
);

CREATE TABLE public.creation_pricing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pricing_key text NOT NULL,
    candy_cost integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT creation_pricing_cost_positive CHECK ((candy_cost > 0)),
    CONSTRAINT creation_pricing_key_not_empty CHECK ((btrim(pricing_key) <> ''::text))
);

CREATE TABLE public.drawing_animation_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    upload_url text NOT NULL,
    animation_style text,
    output_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.examples (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    description text,
    character_id uuid,
    media_url text NOT NULL,
    thumbnail_url text,
    is_published boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    badge_label text DEFAULT ''::text NOT NULL,
    CONSTRAINT examples_badge_label_check CHECK ((char_length(badge_label) <= 40)),
    CONSTRAINT examples_kind_check CHECK ((kind = ANY (ARRAY['video'::text, 'drawing'::text, 'story'::text])))
);

CREATE TABLE public.homepage_content (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton_key text DEFAULT 'homepage'::text NOT NULL,
    content_json jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT homepage_content_content_json_check CHECK ((jsonb_typeof(content_json) = 'object'::text)),
    CONSTRAINT homepage_content_revision_check CHECK ((revision >= 1)),
    CONSTRAINT homepage_content_singleton_key_check CHECK ((singleton_key = 'homepage'::text))
);

CREATE TABLE public.homepage_hero_layout (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton_key text DEFAULT 'hero'::text NOT NULL,
    tv_rect jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT homepage_hero_layout_revision_check CHECK ((revision >= 1)),
    CONSTRAINT homepage_hero_layout_singleton_key_check CHECK ((singleton_key = 'hero'::text)),
    CONSTRAINT homepage_hero_layout_tv_rect_check CHECK ((jsonb_typeof(tv_rect) = 'object'::text))
);

CREATE TABLE public.homepage_media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slot_key text NOT NULL,
    media_type text NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL,
    width integer,
    height integer,
    duration_seconds numeric,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT homepage_media_assets_byte_size_check CHECK ((byte_size > 0)),
    CONSTRAINT homepage_media_assets_duration_seconds_check CHECK (((duration_seconds IS NULL) OR (duration_seconds > (0)::numeric))),
    CONSTRAINT homepage_media_assets_height_check CHECK (((height IS NULL) OR (height > 0))),
    CONSTRAINT homepage_media_assets_media_type_check CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT homepage_media_assets_mime_type_check CHECK ((mime_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'video/mp4'::text, 'video/webm'::text]))),
    CONSTRAINT homepage_media_assets_slot_key_check CHECK ((slot_key = ANY (ARRAY['hero.background'::text, 'hero.tv_video'::text, 'sections.background'::text, 'build_options.card_image'::text, 'build_options.card_video'::text, 'build_options.card_animation'::text, 'safety.image'::text]))),
    CONSTRAINT homepage_media_assets_storage_path_check CHECK (((char_length(TRIM(BOTH FROM storage_path)) > 0) AND (storage_path !~ '^[A-Za-z][A-Za-z0-9+.-]*:'::text) AND (storage_path !~~ '//%'::text) AND (storage_path !~~ '%..%'::text))),
    CONSTRAINT homepage_media_assets_width_check CHECK (((width IS NULL) OR (width > 0))),
    CONSTRAINT homepage_media_type_matches_mime CHECK ((((media_type = 'image'::text) AND (mime_type ~~ 'image/%'::text) AND (duration_seconds IS NULL)) OR ((media_type = 'video'::text) AND (mime_type ~~ 'video/%'::text))))
);

CREATE TABLE public.media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    type text NOT NULL,
    file_url text NOT NULL,
    mime_type text,
    moderation_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    asset_role text DEFAULT 'source'::text NOT NULL,
    delivery_status text,
    uploaded_by_user_id uuid,
    original_filename text,
    byte_size integer,
    superseded_at timestamp with time zone,
    parent_visible boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_assets_asset_role_check CHECK ((asset_role = ANY (ARRAY['source'::text, 'final'::text, 'preview'::text, 'supporting'::text]))),
    CONSTRAINT media_assets_byte_size_positive_check CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
    CONSTRAINT media_assets_delivery_status_check CHECK (((delivery_status IS NULL) OR (delivery_status = ANY (ARRAY['uploaded'::text, 'approved'::text, 'superseded'::text])))),
    CONSTRAINT media_assets_filename_len_check CHECK (((original_filename IS NULL) OR (char_length(original_filename) <= 255))),
    CONSTRAINT media_assets_final_has_delivery_check CHECK (((asset_role <> ALL (ARRAY['final'::text, 'preview'::text])) OR (delivery_status IS NOT NULL))),
    CONSTRAINT media_assets_final_type_generated_check CHECK (((asset_role <> ALL (ARRAY['final'::text, 'preview'::text])) OR (type = 'generated'::text))),
    CONSTRAINT media_assets_moderation_status_check CHECK ((moderation_status = ANY (ARRAY['pending'::text, 'passed'::text, 'flagged'::text, 'blocked'::text, 'manual_review'::text]))),
    CONSTRAINT media_assets_superseded_hidden_check CHECK (((delivery_status <> 'superseded'::text) OR (parent_visible = false))),
    CONSTRAINT media_assets_superseded_invariants_check CHECK ((((superseded_at IS NOT NULL) AND (delivery_status = 'superseded'::text)) OR ((superseded_at IS NULL) AND (delivery_status IS DISTINCT FROM 'superseded'::text)))),
    CONSTRAINT media_assets_type_check CHECK ((type = ANY (ARRAY['upload'::text, 'generated'::text])))
);

CREATE TABLE public.moderation_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    action text NOT NULL,
    moderator_id uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.order_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    previous_status text,
    new_status text NOT NULL,
    changed_by_user_id uuid,
    internal_note text,
    parent_visible_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_status_history_internal_note_len_check CHECK (((internal_note IS NULL) OR (char_length(internal_note) <= 2000))),
    CONSTRAINT order_status_history_new_status_check CHECK ((new_status = ANY (ARRAY['draft'::text, 'pending_payment'::text, 'pending_review'::text, 'in_progress'::text, 'ready'::text, 'delivered'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT order_status_history_parent_note_len_check CHECK (((parent_visible_note IS NULL) OR (char_length(parent_visible_note) <= 2000))),
    CONSTRAINT order_status_history_previous_status_check CHECK (((previous_status IS NULL) OR (previous_status = ANY (ARRAY['draft'::text, 'pending_payment'::text, 'pending_review'::text, 'in_progress'::text, 'ready'::text, 'delivered'::text, 'rejected'::text, 'cancelled'::text]))))
);

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    title text,
    description text,
    character_id uuid,
    candy_cost integer DEFAULT 0 NOT NULL,
    moderation_status text DEFAULT 'pending'::text NOT NULL,
    assigned_admin_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    child_name text,
    submission_key uuid,
    payment_source text DEFAULT 'candy'::text NOT NULL,
    CONSTRAINT orders_child_name_check CHECK (((child_name IS NULL) OR (((char_length(child_name) >= 1) AND (char_length(child_name) <= 60)) AND (char_length(btrim(child_name)) > 0)))),
    CONSTRAINT orders_moderation_status_check CHECK ((moderation_status = ANY (ARRAY['pending'::text, 'passed'::text, 'flagged'::text, 'blocked'::text, 'manual_review'::text]))),
    CONSTRAINT orders_payment_source_check CHECK ((payment_source = ANY (ARRAY['candy'::text, 'welcome_image_credit'::text]))),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_payment'::text, 'pending_review'::text, 'in_progress'::text, 'ready'::text, 'delivered'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT orders_type_check CHECK ((type = ANY (ARRAY['image'::text, 'video'::text, 'drawing_animation'::text]))),
    CONSTRAINT orders_welcome_credit_image_only CHECK (((payment_source = 'candy'::text) OR (type = 'image'::text)))
);

CREATE TABLE public.parent_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    full_name text,
    consent_granted boolean DEFAULT false NOT NULL,
    consent_granted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    referral_code text NOT NULL,
    CONSTRAINT parent_profiles_full_name_check CHECK (((full_name IS NULL) OR (char_length(btrim(full_name)) > 0))),
    CONSTRAINT parent_profiles_referral_code_check CHECK ((referral_code ~ '^CT[0-9A-F]{12}$'::text))
);

CREATE TABLE public.parent_welcome_credit_usages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    order_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.parent_welcome_credits (
    parent_id uuid NOT NULL,
    granted_count integer DEFAULT 3 NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parent_welcome_credits_granted_count_check CHECK ((granted_count > 0)),
    CONSTRAINT parent_welcome_credits_not_overspent CHECK ((used_count <= granted_count)),
    CONSTRAINT parent_welcome_credits_used_count_check CHECK ((used_count >= 0))
);

CREATE TABLE public.payment_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_id uuid NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    provider_session_id text,
    provider_transaction_id text,
    provider_payment_reference text,
    checkout_url text,
    checkout_expires_at timestamp with time zone,
    requested_amount integer NOT NULL,
    requested_currency text NOT NULL,
    verified_amount integer,
    verified_currency text,
    provider_verified_at timestamp with time zone,
    failure_code text,
    failure_message_safe text,
    attempt_number integer NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT payment_attempts_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT payment_attempts_failure_message_safe_check CHECK (((failure_message_safe IS NULL) OR (char_length(failure_message_safe) <= 500))),
    CONSTRAINT payment_attempts_provider_check CHECK ((char_length(TRIM(BOTH FROM provider)) > 0)),
    CONSTRAINT payment_attempts_requested_amount_check CHECK ((requested_amount > 0)),
    CONSTRAINT payment_attempts_requested_currency_check CHECK ((char_length(TRIM(BOTH FROM requested_currency)) > 0)),
    CONSTRAINT payment_attempts_status_check CHECK ((status = ANY (ARRAY['created'::text, 'awaiting_payment'::text, 'processing'::text, 'verified'::text, 'failed'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT payment_attempts_verified_amount_check CHECK (((verified_amount IS NULL) OR (verified_amount > 0)))
);

CREATE TABLE public.payment_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    event_type text NOT NULL,
    attempt_id uuid,
    purchase_id uuid,
    processing_status text DEFAULT 'received'::text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_webhook_events_event_type_check CHECK ((char_length(TRIM(BOTH FROM event_type)) > 0)),
    CONSTRAINT payment_webhook_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['received'::text, 'processed'::text, 'ignored'::text, 'failed'::text]))),
    CONSTRAINT payment_webhook_events_provider_check CHECK ((char_length(TRIM(BOTH FROM provider)) > 0)),
    CONSTRAINT payment_webhook_events_provider_event_id_check CHECK ((char_length(TRIM(BOTH FROM provider_event_id)) > 0))
);

CREATE TABLE public.referral_binding_rate_limits (
    parent_id uuid NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    attempt_count integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_binding_rate_limits_attempt_count_check CHECK ((attempt_count >= 0))
);

CREATE TABLE public.referral_program_settings (
    id smallint NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    reward_basis_points integer DEFAULT 1500 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT referral_program_settings_id_check CHECK ((id = 1)),
    CONSTRAINT referral_program_settings_reward_basis_points_check CHECK (((reward_basis_points >= 0) AND (reward_basis_points <= 10000)))
);

CREATE TABLE public.referral_program_settings_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid,
    previous_is_enabled boolean NOT NULL,
    new_is_enabled boolean NOT NULL,
    previous_reward_basis_points integer NOT NULL,
    new_reward_basis_points integer NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_program_settings_hi_previous_reward_basis_points_check CHECK (((previous_reward_basis_points >= 0) AND (previous_reward_basis_points <= 10000))),
    CONSTRAINT referral_program_settings_history_new_reward_basis_points_check CHECK (((new_reward_basis_points >= 0) AND (new_reward_basis_points <= 10000))),
    CONSTRAINT settings_history_values_differ CHECK (((previous_is_enabled IS DISTINCT FROM new_is_enabled) OR (previous_reward_basis_points IS DISTINCT FROM new_reward_basis_points)))
);

CREATE TABLE public.referral_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referred_parent_id uuid,
    referrer_parent_id uuid,
    referral_code_snapshot text NOT NULL,
    binding_source text DEFAULT 'manual'::text NOT NULL,
    bound_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_relationships_binding_source_check CHECK ((binding_source = ANY (ARRAY['manual'::text, 'signup_link'::text]))),
    CONSTRAINT referral_relationships_no_self_referral CHECK (((referred_parent_id IS NULL) OR (referrer_parent_id IS NULL) OR (referred_parent_id <> referrer_parent_id))),
    CONSTRAINT referral_relationships_referral_code_snapshot_check CHECK ((referral_code_snapshot ~ '^CT[0-9A-F]{12}$'::text))
);

CREATE TABLE public.users (
    id uuid NOT NULL,
    email text,
    role text DEFAULT 'parent'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['parent'::text, 'admin'::text, 'super_admin'::text])))
);

CREATE TABLE public.video_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    script text,
    duration_seconds integer,
    style text,
    output_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_choice text,
    characters_speak boolean,
    CONSTRAINT video_requests_duration_choice_valid CHECK (((duration_choice IS NULL) OR (duration_choice = ANY (ARRAY['5_10'::text, '10_20'::text, '30_plus'::text]))))
);

-- ══ Primary keys, unique and exclusion constraints ══

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.candy_packages
    ADD CONSTRAINT candy_packages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.candy_purchases
    ADD CONSTRAINT candy_purchases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.candy_transactions
    ADD CONSTRAINT candy_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.candy_wallets
    ADD CONSTRAINT candy_wallets_parent_id_key UNIQUE (parent_id);

ALTER TABLE ONLY public.candy_wallets
    ADD CONSTRAINT candy_wallets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.coupon_package_rules
    ADD CONSTRAINT coupon_package_rules_pkey PRIMARY KEY (coupon_id, package_id);

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_purchase_idempotency_unique UNIQUE (purchase_id, idempotency_key);

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_purchase_unique UNIQUE (purchase_id);

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_code_unique UNIQUE (code);

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.creation_pricing
    ADD CONSTRAINT creation_pricing_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drawing_animation_requests
    ADD CONSTRAINT drawing_animation_requests_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.drawing_animation_requests
    ADD CONSTRAINT drawing_animation_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.examples
    ADD CONSTRAINT examples_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homepage_content
    ADD CONSTRAINT homepage_content_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homepage_content
    ADD CONSTRAINT homepage_content_singleton_key_key UNIQUE (singleton_key);

ALTER TABLE ONLY public.homepage_hero_layout
    ADD CONSTRAINT homepage_hero_layout_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homepage_hero_layout
    ADD CONSTRAINT homepage_hero_layout_singleton_key_key UNIQUE (singleton_key);

ALTER TABLE ONLY public.homepage_media_assets
    ADD CONSTRAINT homepage_media_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.homepage_media_assets
    ADD CONSTRAINT homepage_media_assets_slot_key_key UNIQUE (slot_key);

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.moderation_logs
    ADD CONSTRAINT moderation_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.parent_profiles
    ADD CONSTRAINT parent_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.parent_profiles
    ADD CONSTRAINT parent_profiles_referral_code_unique UNIQUE (referral_code);

ALTER TABLE ONLY public.parent_profiles
    ADD CONSTRAINT parent_profiles_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.parent_welcome_credit_usages
    ADD CONSTRAINT parent_welcome_credit_usages_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.parent_welcome_credit_usages
    ADD CONSTRAINT parent_welcome_credit_usages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.parent_welcome_credits
    ADD CONSTRAINT parent_welcome_credits_pkey PRIMARY KEY (parent_id);

ALTER TABLE ONLY public.payment_attempts
    ADD CONSTRAINT payment_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_attempts
    ADD CONSTRAINT payment_attempts_purchase_attempt_unique UNIQUE (purchase_id, attempt_number);

ALTER TABLE ONLY public.payment_attempts
    ADD CONSTRAINT payment_attempts_purchase_idempotency_unique UNIQUE (purchase_id, idempotency_key);

ALTER TABLE ONLY public.payment_webhook_events
    ADD CONSTRAINT payment_webhook_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.referral_binding_rate_limits
    ADD CONSTRAINT referral_binding_rate_limits_pkey PRIMARY KEY (parent_id);

ALTER TABLE ONLY public.referral_program_settings_history
    ADD CONSTRAINT referral_program_settings_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.referral_program_settings
    ADD CONSTRAINT referral_program_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.referral_relationships
    ADD CONSTRAINT referral_relationships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_requests
    ADD CONSTRAINT video_requests_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.video_requests
    ADD CONSTRAINT video_requests_pkey PRIMARY KEY (id);

-- ══ Indexes ══

CREATE INDEX idx_candy_purchases_active_payment_attempt_id ON public.candy_purchases USING btree (active_payment_attempt_id);

CREATE UNIQUE INDEX idx_candy_transactions_idempotency_key ON public.candy_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX idx_candy_transactions_wallet_id ON public.candy_transactions USING btree (wallet_id);

CREATE INDEX idx_child_profiles_parent_id ON public.child_profiles USING btree (parent_id);

CREATE INDEX idx_coupon_package_rules_package ON public.coupon_package_rules USING btree (package_id);

CREATE INDEX idx_coupon_redemptions_coupon_id ON public.coupon_redemptions USING btree (coupon_id);

CREATE INDEX idx_coupon_redemptions_parent_status ON public.coupon_redemptions USING btree (parent_profile_id, status);

CREATE INDEX idx_coupons_active_lookup ON public.coupons USING btree (is_active, starts_at, expires_at);

CREATE UNIQUE INDEX idx_creation_pricing_key ON public.creation_pricing USING btree (pricing_key);

CREATE INDEX idx_examples_kind ON public.examples USING btree (kind);

CREATE INDEX idx_examples_published_sort ON public.examples USING btree (is_published, sort_order) WHERE (is_published = true);

CREATE INDEX idx_media_assets_order_id ON public.media_assets USING btree (order_id);

CREATE INDEX idx_media_assets_order_role_status ON public.media_assets USING btree (order_id, asset_role, delivery_status, parent_visible);

CREATE INDEX idx_order_status_history_order_created ON public.order_status_history USING btree (order_id, created_at DESC);

CREATE INDEX idx_orders_parent_id ON public.orders USING btree (parent_id);

CREATE INDEX idx_payment_attempts_created_at ON public.payment_attempts USING btree (created_at);

CREATE UNIQUE INDEX idx_payment_attempts_provider_session ON public.payment_attempts USING btree (provider, provider_session_id) WHERE (provider_session_id IS NOT NULL);

CREATE UNIQUE INDEX idx_payment_attempts_provider_transaction ON public.payment_attempts USING btree (provider, provider_transaction_id) WHERE (provider_transaction_id IS NOT NULL);

CREATE INDEX idx_payment_attempts_purchase_id ON public.payment_attempts USING btree (purchase_id);

CREATE INDEX idx_payment_attempts_status ON public.payment_attempts USING btree (status);

CREATE UNIQUE INDEX idx_payment_attempts_verified_once ON public.payment_attempts USING btree (purchase_id) WHERE (status = 'verified'::text);

CREATE INDEX idx_payment_webhook_events_attempt_id ON public.payment_webhook_events USING btree (attempt_id);

CREATE INDEX idx_payment_webhook_events_processing_status ON public.payment_webhook_events USING btree (processing_status);

CREATE UNIQUE INDEX idx_payment_webhook_events_provider_event ON public.payment_webhook_events USING btree (provider, provider_event_id);

CREATE INDEX idx_payment_webhook_events_purchase_id ON public.payment_webhook_events USING btree (purchase_id);

CREATE INDEX idx_referral_relationships_bound_at ON public.referral_relationships USING btree (bound_at DESC);

CREATE UNIQUE INDEX idx_referral_relationships_referred ON public.referral_relationships USING btree (referred_parent_id) WHERE (referred_parent_id IS NOT NULL);

CREATE INDEX idx_referral_relationships_referrer ON public.referral_relationships USING btree (referrer_parent_id);

CREATE INDEX idx_settings_history_actor ON public.referral_program_settings_history USING btree (actor_user_id) WHERE (actor_user_id IS NOT NULL);

CREATE INDEX idx_settings_history_changed_at ON public.referral_program_settings_history USING btree (changed_at DESC);

CREATE UNIQUE INDEX orders_parent_submission_key_key ON public.orders USING btree (parent_id, submission_key) WHERE (submission_key IS NOT NULL);

CREATE INDEX parent_welcome_credit_usages_parent_idx ON public.parent_welcome_credit_usages USING btree (parent_id);

-- ══ Foreign keys (public.users no longer references an external auth table) ══

ALTER TABLE ONLY public.candy_purchases
    ADD CONSTRAINT candy_purchases_active_payment_attempt_fkey FOREIGN KEY (active_payment_attempt_id) REFERENCES public.payment_attempts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.candy_purchases
    ADD CONSTRAINT candy_purchases_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.candy_packages(id);

ALTER TABLE ONLY public.candy_purchases
    ADD CONSTRAINT candy_purchases_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.candy_transactions
    ADD CONSTRAINT candy_transactions_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.candy_wallets(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.candy_wallets
    ADD CONSTRAINT candy_wallets_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.coupon_package_rules
    ADD CONSTRAINT coupon_package_rules_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.coupon_package_rules
    ADD CONSTRAINT coupon_package_rules_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.candy_packages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id);

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_parent_profile_id_fkey FOREIGN KEY (parent_profile_id) REFERENCES public.parent_profiles(id);

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.candy_purchases(id);

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.drawing_animation_requests
    ADD CONSTRAINT drawing_animation_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.examples
    ADD CONSTRAINT examples_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homepage_content
    ADD CONSTRAINT homepage_content_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homepage_hero_layout
    ADD CONSTRAINT homepage_hero_layout_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.homepage_media_assets
    ADD CONSTRAINT homepage_media_assets_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.moderation_logs
    ADD CONSTRAINT moderation_logs_moderator_id_fkey FOREIGN KEY (moderator_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_changed_by_user_id_fkey FOREIGN KEY (changed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.order_status_history
    ADD CONSTRAINT order_status_history_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.parent_profiles
    ADD CONSTRAINT parent_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.parent_welcome_credit_usages
    ADD CONSTRAINT parent_welcome_credit_usages_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.parent_welcome_credit_usages
    ADD CONSTRAINT parent_welcome_credit_usages_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_welcome_credits(parent_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.parent_welcome_credits
    ADD CONSTRAINT parent_welcome_credits_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_attempts
    ADD CONSTRAINT payment_attempts_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.candy_purchases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payment_webhook_events
    ADD CONSTRAINT payment_webhook_events_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES public.payment_attempts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payment_webhook_events
    ADD CONSTRAINT payment_webhook_events_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.candy_purchases(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_binding_rate_limits
    ADD CONSTRAINT referral_binding_rate_limits_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.referral_program_settings_history
    ADD CONSTRAINT referral_program_settings_history_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_program_settings
    ADD CONSTRAINT referral_program_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_relationships
    ADD CONSTRAINT referral_relationships_referred_parent_id_fkey FOREIGN KEY (referred_parent_id) REFERENCES public.parent_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_relationships
    ADD CONSTRAINT referral_relationships_referrer_parent_id_fkey FOREIGN KEY (referrer_parent_id) REFERENCES public.parent_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.video_requests
    ADD CONSTRAINT video_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

-- ══ Comments ══

COMMENT ON TABLE public.audit_logs IS 'Immutable audit trail for sensitive operations, written only by the trusted backend (see lib/audit/final-media-audit.ts). Append-only is enforced by the append_only_guard trigger (0006). Any admin-facing read goes through the backend, which checks the caller''s role.';

COMMENT ON TABLE public.candy_packages IS 'Predefined candy purchase packages. Active packages are visible to authenticated users for purchase.';

COMMENT ON COLUMN public.candy_packages.name IS 'Human-readable package name (e.g. Starter, Growth, Premium).';

COMMENT ON COLUMN public.candy_packages.description IS 'Optional marketing or descriptive text.';

COMMENT ON COLUMN public.candy_packages.candy_amount IS 'Number of candies the purchaser receives. Must be positive.';

COMMENT ON COLUMN public.candy_packages.price_amount IS 'Price in the smallest currency unit (e.g. Rials). Must be positive.';

COMMENT ON COLUMN public.candy_packages.currency IS 'ISO 4217 currency code (default IRR).';

COMMENT ON COLUMN public.candy_packages.is_active IS 'Controls catalog visibility. Inactive packages cannot be purchased.';

COMMENT ON COLUMN public.candy_packages.display_order IS 'Ascending sort order for UI presentation.';

COMMENT ON TABLE public.candy_purchases IS 'Records of candy purchase attempts. Status lifecycle: pending → paid | failed | cancelled.';

COMMENT ON COLUMN public.candy_purchases.parent_id IS 'Parent who initiated the purchase.';

COMMENT ON COLUMN public.candy_purchases.package_id IS 'The candy package selected for purchase.';

COMMENT ON COLUMN public.candy_purchases.candy_amount IS 'Candy amount at time of purchase (snapshot from package).';

COMMENT ON COLUMN public.candy_purchases.price_amount IS 'Original package price snapshot in integer RIAL (IRR). Backward-compatible alias of the pre-discount amount; equals original_price_amount.';

COMMENT ON COLUMN public.candy_purchases.status IS 'pending | paid | failed | cancelled | expired. Transient provider states live on payment_attempts.';

COMMENT ON COLUMN public.candy_purchases.payment_reference IS 'External payment reference. NULL until payment completes.';

COMMENT ON COLUMN public.candy_purchases.paid_at IS 'Timestamp when payment was confirmed. NULL until paid.';

COMMENT ON COLUMN public.candy_purchases.active_payment_attempt_id IS 'ID of the current payment attempt for this purchase (pointer to payment_attempts).';

COMMENT ON COLUMN public.candy_purchases.payment_provider IS 'Provider engaged for the current attempt (mirror of active attempt provider). NULL before a session is created.';

COMMENT ON COLUMN public.candy_purchases.provider_verified_at IS 'When the purchase payment was verified by trusted server-to-server verification. NULL until verified.';

COMMENT ON COLUMN public.candy_purchases.expires_at IS 'When the current checkout expires. NULL unless an active checkout exists.';

COMMENT ON COLUMN public.candy_purchases.cancelled_at IS 'When the purchase was cancelled by the parent. NULL until cancelled.';

COMMENT ON COLUMN public.candy_purchases.failed_at IS 'When the entire purchase was marked failed. NULL until failed.';

COMMENT ON COLUMN public.candy_purchases.original_price_amount IS 'Explicit original (pre-discount) package price snapshot in integer RIAL. Equals price_amount by constraint.';

COMMENT ON COLUMN public.candy_purchases.discount_amount IS 'Coupon discount applied in integer RIAL. Zero when no coupon is applied.';

COMMENT ON COLUMN public.candy_purchases.final_price_amount IS 'Payable amount after discount in integer RIAL. Payment provider attempts must charge this amount (never price_amount). Equals original − discount.';

COMMENT ON COLUMN public.candy_transactions.idempotency_key IS 'Server-generated unique key for idempotent ledger writes. NULL until the atomic-spend RPC is implemented.';

COMMENT ON TABLE public.characters IS 'Original Cartoona characters. Seeded from config/characters.ts by 20260918130000; the creation forms render that same list and the request RPC resolves the chosen name against this table.';

COMMENT ON TABLE public.coupon_package_rules IS 'Package restrictions per coupon. Zero rows for a coupon = applies to ALL active packages. One or more rows = applies ONLY to those packages. Contains package IDs only — never duplicated price or candy amounts.';

COMMENT ON TABLE public.coupon_redemptions IS 'One row per coupon applied to a purchase. UNIQUE (purchase_id) enforces at most one coupon per purchase. status: reserved → redeemed (verified paid) or cancelled. All monetary values are integer RIAL (IRR). Percentage snapshots are integer basis points.';

COMMENT ON COLUMN public.coupon_redemptions.normalized_code_snapshot IS 'Normalized coupon code at apply time (audit).';

COMMENT ON COLUMN public.coupon_redemptions.discount_type_snapshot IS 'Discount type at apply time.';

COMMENT ON COLUMN public.coupon_redemptions.discount_value_snapshot IS 'Discount value at apply time (basis points for percentage, RIAL for fixed).';

COMMENT ON COLUMN public.coupon_redemptions.original_price_amount IS 'Purchase original price snapshot in integer RIAL (equals candy_purchases.original_price_amount).';

COMMENT ON COLUMN public.coupon_redemptions.discount_amount IS 'Discount applied in integer RIAL.';

COMMENT ON COLUMN public.coupon_redemptions.final_price_amount IS 'Payable amount after discount in integer RIAL.';

COMMENT ON COLUMN public.coupon_redemptions.status IS 'reserved = applied to a pending purchase; redeemed = purchase paid+verified; cancelled = purchase cancelled/expired and reservation released.';

COMMENT ON COLUMN public.coupon_redemptions.idempotency_key IS 'Server-side idempotency key for apply. UNIQUE per purchase. Never timestamp-only.';

COMMENT ON TABLE public.coupons IS 'Server-authoritative coupon catalogue. Coupon codes are normalized to UPPERCASE and matched case-insensitively. No parent may query this table directly (code enumeration protection); admins may SELECT. Zero rows are seeded by migration — coupons are created only after commercial approval.';

COMMENT ON COLUMN public.coupons.code IS 'Normalized coupon code: uppercase A-Z, 0-9, hyphen, underscore, 3-32 chars. Stored already normalized; CHECK enforces code = upper(trim(code)).';

COMMENT ON COLUMN public.coupons.discount_type IS 'percentage | fixed_amount. Percentage values are integer basis points.';

COMMENT ON COLUMN public.coupons.discount_value IS 'Percentage: integer basis points (1000 = 10%, min 1, max 10000). Fixed amount: positive integer RIAL (IRR).';

COMMENT ON COLUMN public.coupons.minimum_purchase_amount IS 'Minimum original purchase amount in integer RIAL required before discount. NULL = no minimum.';

COMMENT ON COLUMN public.coupons.maximum_discount_amount IS 'Cap on the calculated discount in integer RIAL. Applied after percentage calculation. NULL = no cap.';

COMMENT ON COLUMN public.coupons.created_by_user_id IS 'Admin user who created the coupon (public.users). NULL if created outside the app.';

COMMENT ON TABLE public.creation_pricing IS 'Authoritative creation-pricing catalog. pricing_key maps request type+options to a candy cost. Only active rows are publicly visible.';

COMMENT ON COLUMN public.creation_pricing.pricing_key IS 'Stable machine-readable identifier. Never contains the numeric price or Persian labels.';

COMMENT ON COLUMN public.creation_pricing.candy_cost IS 'Positive integer — candy cost for this pricing component. Base prices and surcharges are additive.';

COMMENT ON COLUMN public.creation_pricing.is_active IS 'Controls public visibility and RPC eligibility. Inactive rows are hidden from non-admin queries and cannot be used for new order costing.';

COMMENT ON TABLE public.examples IS 'Curated examples for the public showcase page. Managed by admins.';

COMMENT ON COLUMN public.examples.kind IS 'Example category: video, drawing, or story.';

COMMENT ON COLUMN public.examples.character_id IS 'Optional character featured in this example.';

COMMENT ON COLUMN public.examples.media_url IS 'File URL in the example-media storage bucket.';

COMMENT ON COLUMN public.examples.is_published IS 'Controls visibility on the public showcase.';

COMMENT ON COLUMN public.examples.sort_order IS 'Ascending sort position in the showcase grid.';

COMMENT ON TABLE public.homepage_content IS 'Editable marketing homepage copy. Exactly one row, addressed by singleton_key = ''homepage''. Structure, layout and motion stay in code.';

COMMENT ON COLUMN public.homepage_content.singleton_key IS 'Fixed to ''homepage''. The CHECK plus UNIQUE constraint together permit exactly one row.';

COMMENT ON COLUMN public.homepage_content.content_json IS 'HomepageContent object. Validated by the application on write and re-validated on read; malformed content falls back to bundled defaults.';

COMMENT ON COLUMN public.homepage_content.revision IS 'Monotonic counter bumped by the admin write path. Used for optimistic concurrency and audit.';

COMMENT ON COLUMN public.homepage_content.updated_by_user_id IS 'Admin who last saved. Nullable so the seeded row and system writes need no user.';

COMMENT ON TABLE public.homepage_hero_layout IS 'Normalized TV screen rect for the hero background artwork. Exactly one row (singleton_key = ''hero''). Fractions only; zoom/focus/crop stay in code. Not read by the public hero until Phase 4.';

COMMENT ON COLUMN public.homepage_hero_layout.tv_rect IS 'JSON object {x, y, width, height}, each 0.0–1.0, x+width <= 1, y+height <= 1. Validated by the application and re-checked by the trusted RPC.';

COMMENT ON COLUMN public.homepage_hero_layout.revision IS 'Monotonic counter for optimistic concurrency on calibration edits.';

COMMENT ON TABLE public.homepage_media_assets IS 'Current media object for each named homepage slot. Metadata only — bytes live in storage. One row per slot, enforced by the UNIQUE constraint on slot_key.';

COMMENT ON COLUMN public.homepage_media_assets.slot_key IS 'Closed set of design positions, mirrored in lib/homepage/media-slots.ts. Editors cannot invent slots.';

COMMENT ON COLUMN public.homepage_media_assets.storage_path IS 'Object key inside the storage bucket. Never a URL: the CHECK rejects schemes, protocol-relative prefixes and path traversal.';

COMMENT ON COLUMN public.homepage_media_assets.byte_size IS 'Size in bytes of the stored object, recorded at upload time.';

COMMENT ON COLUMN public.homepage_media_assets.duration_seconds IS 'Video duration. Always NULL for images, enforced by homepage_media_type_matches_mime.';

COMMENT ON COLUMN public.media_assets.asset_role IS 'source (parent input) | final (admin deliverable) | preview | supporting.';

COMMENT ON COLUMN public.media_assets.delivery_status IS 'uploaded → approved (parent-visible) → superseded (hidden, history kept).';

COMMENT ON COLUMN public.media_assets.parent_visible IS 'False until an admin explicitly approves the asset. Only approved final assets are ever exposed to parents.';

COMMENT ON TABLE public.order_status_history IS 'Append-only status-change audit for orders. Never updated or deleted directly. Internal notes are admin-only; parents read only parent_visible_note via the dedicated SECURITY DEFINER function.';

COMMENT ON COLUMN public.order_status_history.internal_note IS 'Admin-only note. Never exposed through any parent-facing query/API.';

COMMENT ON COLUMN public.order_status_history.parent_visible_note IS 'Optional message shown to the parent for this status change.';

COMMENT ON COLUMN public.orders.child_name IS 'Optional child first name supplied by the parent on the creation form. NULL for every request that did not provide one, including all rows created before this column existed. Not a link to child_profiles.';

COMMENT ON COLUMN public.orders.submission_key IS 'Client-generated idempotency key for one logical creation submit attempt. NULL for every order created before this column existed. Unique per parent (see orders_parent_submission_key_key) so a retried POST for the same attempt returns the existing order instead of creating another.';

COMMENT ON COLUMN public.orders.payment_source IS 'What paid for the order: candy (default, all historical orders) or welcome_image_credit (image orders only, candy_cost = 0).';

COMMENT ON COLUMN public.parent_profiles.full_name IS 'Optional parent display name. NULL for accounts created through the phone + OTP signup, which never asks for one. Never a placeholder: the UI falls back to "حساب والد" when this is NULL.';

COMMENT ON COLUMN public.parent_profiles.referral_code IS 'Unique immutable referral code (CT + 12 uppercase hex chars). Database-generated. Parents cannot choose or modify.';

COMMENT ON TABLE public.parent_welcome_credit_usages IS 'One row per welcome image credit spent. UNIQUE(order_id): an order can be paid by a credit at most once.';

COMMENT ON TABLE public.parent_welcome_credits IS 'One-time welcome IMAGE credits per parent (not candy). remaining = granted_count - used_count. Written only by trusted server code / SECURITY DEFINER functions.';

COMMENT ON TABLE public.payment_attempts IS 'One row per attempt to pay a candy purchase. A purchase may have multiple attempts; at most one may be verified. Attempt-level provider state (session, transaction, checkout URL, verification, failure) lives here, never on the purchase. The trusted backend creates and updates attempts only.';

COMMENT ON COLUMN public.payment_attempts.provider IS 'Provider-neutral text name of the payment provider (e.g. zarinpal, nextpay). No SDK types stored.';

COMMENT ON COLUMN public.payment_attempts.status IS 'created → awaiting_payment → processing → verified | failed | cancelled | expired.';

COMMENT ON COLUMN public.payment_attempts.provider_session_id IS 'Provider checkout/session reference for this attempt. Unique per provider when present.';

COMMENT ON COLUMN public.payment_attempts.provider_transaction_id IS 'Provider payment transaction reference. Unique per provider when present.';

COMMENT ON COLUMN public.payment_attempts.provider_payment_reference IS 'Optional provider-issued payment reference (e.g. authority, invoice).';

COMMENT ON COLUMN public.payment_attempts.checkout_url IS 'Provider redirect URL for this attempt. Never stored on candy_purchases.';

COMMENT ON COLUMN public.payment_attempts.requested_amount IS 'Amount requested from provider, copied from candy_purchases.price_amount snapshot. Integer RIAL (IRR).';

COMMENT ON COLUMN public.payment_attempts.requested_currency IS 'Currency requested from provider, copied from candy_purchases.currency snapshot. Currently IRR.';

COMMENT ON COLUMN public.payment_attempts.verified_amount IS 'Amount confirmed by provider-side verification. Must equal purchase.price_amount to be verified. Integer RIAL (IRR).';

COMMENT ON COLUMN public.payment_attempts.verified_currency IS 'Currency confirmed by provider-side verification. Must equal purchase.currency.';

COMMENT ON COLUMN public.payment_attempts.failure_code IS 'Safe, stable failure code for support and display decisions (e.g. session_expired, declined).';

COMMENT ON COLUMN public.payment_attempts.failure_message_safe IS 'Human-safe failure message. MUST NEVER contain raw secrets, full provider payloads, or card data.';

COMMENT ON COLUMN public.payment_attempts.attempt_number IS '1-based attempt ordinal within the purchase. UNIQUE per purchase.';

COMMENT ON COLUMN public.payment_attempts.idempotency_key IS 'Server-side idempotency key for attempt creation. UNIQUE per purchase. Never timestamp-only.';

COMMENT ON COLUMN public.payment_attempts.completed_at IS 'When the attempt reached a terminal status (verified/failed/cancelled/expired).';

COMMENT ON TABLE public.payment_webhook_events IS 'Deduplication table for provider webhook events. Check UNIQUE(provider, provider_event_id) BEFORE any financial mutation. Never stores raw payloads, signatures, secrets, or card data.';

COMMENT ON COLUMN public.payment_webhook_events.provider_event_id IS 'Provider-issued unique event ID. Combined with provider it is unique.';

COMMENT ON COLUMN public.payment_webhook_events.attempt_id IS 'Optional link to the payment attempt this event refers to (SET NULL if attempt removed).';

COMMENT ON COLUMN public.payment_webhook_events.purchase_id IS 'Optional link to the purchase this event refers to (SET NULL if purchase removed).';

COMMENT ON COLUMN public.payment_webhook_events.processing_status IS 'received → processed | ignored | failed. Set by trusted server after handling.';

COMMENT ON COLUMN public.payment_webhook_events.failure_code IS 'Safe failure code if processing failed. Never raw provider payload.';

COMMENT ON TABLE public.referral_binding_rate_limits IS 'Per-parent rate limit state for referral-code binding attempts. Five per fixed one-minute window. Only trusted SECURITY DEFINER functions may access this table.';

COMMENT ON TABLE public.referral_program_settings IS 'Singleton row (id=1) controlling the global referral program.';

COMMENT ON COLUMN public.referral_program_settings.reward_basis_points IS 'Reward amount in basis points (1 bp = 0.01%). 1500 = 15%.';

COMMENT ON TABLE public.referral_program_settings_history IS 'Immutable audit trail for referral-program-settings changes. INSERT only via SECURITY DEFINER RPC.';

COMMENT ON TABLE public.referral_relationships IS 'Records which parent referred which other parent. One binding per referred parent. Self-referral forbidden.';

COMMENT ON COLUMN public.referral_relationships.referral_code_snapshot IS 'Snapshot of the referrer referral_code at binding time. Immutable copy, not a live FK.';

COMMENT ON COLUMN public.video_requests.duration_choice IS 'Parent-facing duration choice: 5_10, 10_20 or 30_plus. NULL for requests created before the choice existed. Maps one-to-one onto the short/medium/long pricing tiers.';

COMMENT ON COLUMN public.video_requests.characters_speak IS 'Whether the characters should speak. Required for new video requests; NULL on historical rows, which are never inferred or rewritten.';

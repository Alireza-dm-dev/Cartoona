-- Migration: welcome_image_credits
--
-- Every parent receives exactly 3 one-time WELCOME IMAGE CREDITS.
--
-- Product rules enforced here:
--   * These are NOT candy. They live in their own table, never touch
--     candy_wallets.balance, and never write a candy_transactions row.
--   * They apply ONLY to image requests. Video and drawing animation never
--     consult them (and orders.payment_source cannot say otherwise: see the
--     CHECK below).
--   * For an image request a credit is spent BEFORE candy. The parent does not
--     choose.
--   * Granted once per parent, durably: parent_id is the PRIMARY KEY, and the
--     grant is `INSERT ... ON CONFLICT DO NOTHING`. Signup retries, repeated
--     logins, concurrent initialisation and profile upserts can only ever hit
--     that conflict.
--   * Consumed ATOMICALLY with order creation, inside the existing trusted
--     request RPC and under the same wallet row lock, so a failed request
--     consumes nothing and a race cannot spend a credit twice.
--
-- Model (narrow on purpose, not a generic credits platform):
--   parent_welcome_credits         one row per parent: granted_count, used_count
--   parent_welcome_credit_usages   one immutable row per credit use, UNIQUE per order
--   orders.payment_source          'candy' (default, every historical order) or
--                                  'welcome_image_credit' - answers "which source
--                                  paid for this order" without inferring it from
--                                  balances
--
-- Existing parents: the backfill below grants the same one-time 3 credits to
-- every non-deleted parent who has no grant yet, regardless of candy balance.
--
-- RPC compatibility:
--   create_parent_request_trusted keeps its 16-argument INPUT signature. Its
--   RETURNS TABLE gains a trailing `payment_source` column, which PostgreSQL
--   cannot change in place, so the 16-arg function is dropped and recreated.
--   An app built before this migration ignores the extra column and keeps
--   working; an app built after it tolerates a missing column. Deploy the
--   migration first, then the app; they do not need to be atomic.
--
-- Rollback note: dropping the new tables/column is safe only while no order has
-- payment_source = 'welcome_image_credit' (those orders were charged 0 candy).
-- Prefer rolling forward.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Grant ledger
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.parent_welcome_credits (
  parent_id     UUID PRIMARY KEY REFERENCES public.parent_profiles(id) ON DELETE CASCADE,
  granted_count INTEGER NOT NULL DEFAULT 3 CHECK (granted_count > 0),
  used_count    INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Can never be overspent, whatever code path tries.
  CONSTRAINT parent_welcome_credits_not_overspent CHECK (used_count <= granted_count)
);

COMMENT ON TABLE public.parent_welcome_credits IS
  'One-time welcome IMAGE credits per parent (not candy). remaining = granted_count - used_count. Written only by trusted server code / SECURITY DEFINER functions.';

CREATE TABLE IF NOT EXISTS public.parent_welcome_credit_usages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID NOT NULL REFERENCES public.parent_welcome_credits(parent_id) ON DELETE CASCADE,
  order_id   UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.parent_welcome_credit_usages IS
  'One row per welcome image credit spent. UNIQUE(order_id): an order can be paid by a credit at most once.';

CREATE INDEX IF NOT EXISTS parent_welcome_credit_usages_parent_idx
  ON public.parent_welcome_credit_usages (parent_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. orders.payment_source
--    NOT NULL DEFAULT 'candy' is a metadata-only change on PostgreSQL 11+ and
--    correctly labels every historical order as candy-paid.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'candy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_payment_source_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_source_check
      CHECK (payment_source IN ('candy', 'welcome_image_credit'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_welcome_credit_image_only'
  ) THEN
    -- Structural guarantee that video / drawing animation can never be paid by
    -- a welcome credit, independent of application code.
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_welcome_credit_image_only
      CHECK (payment_source = 'candy' OR type = 'image');
  END IF;
END;
$$;

COMMENT ON COLUMN public.orders.payment_source IS
  'What paid for the order: candy (default, all historical orders) or welcome_image_credit (image orders only, candy_cost = 0).';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. One-time grant for every NEW parent
--    Same pattern as ensure_parent_candy_wallet: an AFTER INSERT trigger on
--    parent_profiles. A profile row is only ever inserted once per user
--    (user_id is UNIQUE), and ON CONFLICT DO NOTHING makes the grant itself
--    idempotent, so retries / races / upserts cannot add credits.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.grant_parent_welcome_image_credits()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = NEW.user_id AND u.role = 'parent' AND u.deleted_at IS NULL
  ) THEN
    INSERT INTO public.parent_welcome_credits (parent_id, granted_count, used_count)
    VALUES (NEW.id, 3, 0)
    ON CONFLICT (parent_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.grant_parent_welcome_image_credits() IS
  'Grants the one-time 3 welcome image credits when a parent profile is created. Idempotent: PRIMARY KEY(parent_id) + ON CONFLICT DO NOTHING.';

REVOKE ALL ON FUNCTION public.grant_parent_welcome_image_credits() FROM PUBLIC;

DROP TRIGGER IF EXISTS grant_parent_welcome_image_credits ON public.parent_profiles;
CREATE TRIGGER grant_parent_welcome_image_credits
  AFTER INSERT ON public.parent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.grant_parent_welcome_image_credits();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Backfill existing parents (once)
--    Every existing, non-deleted PARENT-role account without a grant gets the
--    same single grant. Not conditional on candy balance. Re-running adds
--    nothing (ON CONFLICT DO NOTHING).
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO public.parent_welcome_credits (parent_id, granted_count, used_count)
SELECT pp.id, 3, 0
FROM public.parent_profiles pp
JOIN public.users u ON u.id = pp.user_id
WHERE u.role = 'parent' AND u.deleted_at IS NULL
ON CONFLICT (parent_id) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Access: parents may READ their own credits; nothing may write from the
--    browser roles. Writes happen only through SECURITY DEFINER functions.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.parent_welcome_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_welcome_credit_usages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.parent_welcome_credits FROM anon;
REVOKE ALL ON public.parent_welcome_credits FROM authenticated;
REVOKE ALL ON public.parent_welcome_credit_usages FROM anon;
REVOKE ALL ON public.parent_welcome_credit_usages FROM authenticated;

GRANT SELECT ON public.parent_welcome_credits TO authenticated;
GRANT SELECT ON public.parent_welcome_credit_usages TO authenticated;

DROP POLICY IF EXISTS parent_welcome_credits_select_own ON public.parent_welcome_credits;
CREATE POLICY parent_welcome_credits_select_own ON public.parent_welcome_credits
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.parent_profiles pp
      WHERE pp.id = parent_welcome_credits.parent_id
        AND pp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS parent_welcome_credits_select_admin ON public.parent_welcome_credits;
CREATE POLICY parent_welcome_credits_select_admin ON public.parent_welcome_credits
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

DROP POLICY IF EXISTS parent_welcome_credit_usages_select_own ON public.parent_welcome_credit_usages;
CREATE POLICY parent_welcome_credit_usages_select_own ON public.parent_welcome_credit_usages
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.parent_profiles pp
      WHERE pp.id = parent_welcome_credit_usages.parent_id
        AND pp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS parent_welcome_credit_usages_select_admin ON public.parent_welcome_credit_usages;
CREATE POLICY parent_welcome_credit_usages_select_admin ON public.parent_welcome_credit_usages
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

DROP TRIGGER IF EXISTS parent_welcome_credits_set_updated_at ON public.parent_welcome_credits;
CREATE TRIGGER parent_welcome_credits_set_updated_at
  BEFORE UPDATE ON public.parent_welcome_credits
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Replace the trusted request-creation RPC
--    Same 16-argument input signature as 20260922100000; RETURNS TABLE gains
--    `payment_source`, so the function must be dropped first. Body = that
--    migration's body plus: a post-lock replay re-check, the payment-source
--    decision, and an atomic credit-OR-candy spend.
-- ═════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
);

CREATE OR REPLACE FUNCTION public.create_parent_request_trusted(
  p_parent_profile_id UUID,
  p_order_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_description TEXT DEFAULT NULL,
  p_character_id UUID DEFAULT NULL,
  p_duration_key TEXT DEFAULT NULL,
  p_video_script TEXT DEFAULT NULL,
  p_video_style TEXT DEFAULT NULL,
  p_animation_style TEXT DEFAULT NULL,
  p_file_path TEXT DEFAULT NULL,
  p_duration_choice TEXT DEFAULT NULL,
  p_characters_speak BOOLEAN DEFAULT NULL,
  p_child_name TEXT DEFAULT NULL,
  p_original_filename TEXT DEFAULT NULL,
  p_submission_key UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  type TEXT,
  status TEXT,
  candy_cost INTEGER,
  replayed BOOLEAN,
  payment_source TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent_id      UUID;
  v_user_id        UUID;
  v_candy_cost     INTEGER;
  v_has_file       BOOLEAN;
  v_trusted_mime   TEXT;
  v_wallet_id      UUID;
  v_wallet_balance INTEGER;
  v_pricing_keys   TEXT[];
  v_found_count    INTEGER;
  v_order_id       UUID;
  v_replayed       BOOLEAN := FALSE;
  v_use_credit     BOOLEAN := FALSE;
  v_credit_left    INTEGER;
  v_pay_source     TEXT := 'candy';
  v_charge         INTEGER;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Trusted parent profile resolution
  --    The API route authenticated the caller and resolved this ID from the
  --    parent session. We re-verify the profile exists and consent is granted
  --    (defense in depth — the caller is server-side, but we never trust
  --    client claims blindly).
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'request_parent_profile_missing'
      USING HINT = 'Parent profile not found.';
  END IF;

  SELECT pp.id, pp.user_id
  INTO v_parent_id, v_user_id
  FROM public.parent_profiles pp
  WHERE pp.id = p_parent_profile_id;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'request_parent_profile_missing'
      USING HINT = 'Parent profile not found.';
  END IF;

  -- Reject admin / super_admin callers
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.role IN ('admin', 'super_admin')) THEN
    RAISE EXCEPTION 'request_parent_required'
      USING HINT = 'Only parent accounts can create requests.';
  END IF;

  -- Verify role is parent
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user_id AND u.role = 'parent') THEN
    RAISE EXCEPTION 'request_parent_required'
      USING HINT = 'Parent role required.';
  END IF;

  -- Verify consent is still granted
  IF NOT EXISTS (SELECT 1 FROM public.parent_profiles pp WHERE pp.id = v_parent_id AND pp.consent_granted = TRUE) THEN
    RAISE EXCEPTION 'request_consent_required'
      USING HINT = 'Parent consent must be granted.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1b. Idempotency fast path
  --     Checked before any validation, pricing lookup, or wallet lock so a
  --     plain retry of an already-succeeded submission does none of that work
  --     and cannot fail for a reason the first attempt already got past. Scoped
  --     to v_parent_id — resolved above from the trusted profile id, never
  --     from client input — so one parent can never retrieve another parent's
  --     order by reusing or guessing a submission key.
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_submission_key IS NOT NULL THEN
    SELECT o.id INTO v_order_id
    FROM public.orders o
    WHERE o.parent_id = v_parent_id
      AND o.submission_key = p_submission_key;

    IF v_order_id IS NOT NULL THEN
      v_replayed := TRUE;
    END IF;
  END IF;

  IF NOT v_replayed THEN
    -- ═══════════════════════════════════════════════════════════════════════════
    -- 2. Order ID validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_order_id IS NULL THEN
      RAISE EXCEPTION 'request_invalid_order_id'
        USING HINT = 'Order ID is required.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 3. Type validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type NOT IN ('image', 'video', 'drawing_animation') THEN
      RAISE EXCEPTION 'request_invalid_type'
        USING HINT = 'Type must be image, video, or drawing_animation.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 4. Text validation
    -- ═══════════════════════════════════════════════════════════════════════════
    -- Title is optional. Image and video requests no longer collect one, and a
    -- placeholder is never substituted: the column is nullable and the read
    -- models fall back at display time. Drawing animation still sends a title,
    -- which the API route continues to require.
    IF p_title IS NOT NULL AND char_length(p_title) > 160 THEN
      RAISE EXCEPTION 'request_title_too_long'
        USING HINT = 'Title must not exceed 160 characters.';
    END IF;

    IF p_description IS NOT NULL AND char_length(p_description) > 5000 THEN
      RAISE EXCEPTION 'request_description_too_long'
        USING HINT = 'Description must not exceed 5000 characters.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 5. Character validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type IN ('image', 'video') THEN
      -- Character is required for image and video
      IF p_character_id IS NULL THEN
        RAISE EXCEPTION 'request_character_required'
          USING HINT = 'Character is required for image and video requests.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = p_character_id AND c.is_active = TRUE) THEN
        RAISE EXCEPTION 'request_character_invalid'
          USING HINT = 'Character must exist and be active.';
      END IF;
    ELSIF p_type = 'drawing_animation' THEN
      -- Character must be null for drawing animation
      IF p_character_id IS NOT NULL THEN
        RAISE EXCEPTION 'request_character_not_allowed'
          USING HINT = 'Drawing animation requests must not include a character.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 6. Duration validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type IN ('video', 'drawing_animation') THEN
      IF p_duration_key IS NULL OR p_duration_key NOT IN ('short', 'medium', 'long') THEN
        RAISE EXCEPTION 'request_invalid_duration'
          USING HINT = 'Duration must be short, medium, or long.';
      END IF;
    ELSIF p_type = 'image' THEN
      IF p_duration_key IS NOT NULL THEN
        RAISE EXCEPTION 'request_duration_not_allowed'
          USING HINT = 'Image requests must not include a duration.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 7. Type-specific field validation
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type = 'video' THEN
      IF p_video_script IS NULL OR char_length(trim(p_video_script)) = 0 THEN
        RAISE EXCEPTION 'request_script_required'
          USING HINT = 'Video script is required.';
      END IF;
      IF char_length(p_video_script) > 5000 THEN
        RAISE EXCEPTION 'request_script_too_long'
          USING HINT = 'Video script must not exceed 5000 characters.';
      END IF;
      -- Style is optional: the parent form no longer asks for it. Historical
      -- rows keep the value they were created with.
      IF p_video_style IS NOT NULL AND char_length(p_video_style) > 200 THEN
        RAISE EXCEPTION 'request_style_too_long'
          USING HINT = 'Video style must not exceed 200 characters.';
      END IF;
      IF p_animation_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_animation_style_not_allowed'
          USING HINT = 'Video requests must not include an animation style.';
      END IF;

      -- Parent-facing duration choice. Required, and must agree with the
      -- pricing tier the caller asked for, so the tier cannot be selected
      -- independently of what the parent actually chose.
      IF p_duration_choice IS NULL OR p_duration_choice NOT IN ('5_10', '10_20', '30_plus') THEN
        RAISE EXCEPTION 'request_invalid_duration_choice'
          USING HINT = 'Duration choice must be 5_10, 10_20, or 30_plus.';
      END IF;

      -- Spelled out rather than as a CASE expression: plpgsql ends an IF
      -- condition at the first THEN it sees, so a CASE cannot appear here.
      IF NOT (
        (p_duration_choice = '5_10' AND p_duration_key = 'short')
        OR (p_duration_choice = '10_20' AND p_duration_key = 'medium')
        OR (p_duration_choice = '30_plus' AND p_duration_key = 'long')
      ) THEN
        RAISE EXCEPTION 'request_invalid_duration_choice'
          USING HINT = 'Duration choice does not match the pricing tier.';
      END IF;

      -- Explicit yes/no, never inferred. Historical rows stay NULL.
      IF p_characters_speak IS NULL THEN
        RAISE EXCEPTION 'request_characters_speak_required'
          USING HINT = 'Characters-speak selection is required for video requests.';
      END IF;
    ELSIF p_type = 'drawing_animation' THEN
      IF p_animation_style IS NULL OR char_length(trim(p_animation_style)) = 0 THEN
        RAISE EXCEPTION 'request_animation_style_required'
          USING HINT = 'Animation style is required for drawing animation requests.';
      END IF;
      IF char_length(p_animation_style) > 200 THEN
        RAISE EXCEPTION 'request_animation_style_too_long'
          USING HINT = 'Animation style must not exceed 200 characters.';
      END IF;
      IF p_video_script IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_script_not_allowed'
          USING HINT = 'Drawing animation requests must not include a video script.';
      END IF;
      IF p_video_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_style_not_allowed'
          USING HINT = 'Drawing animation requests must not include a video style.';
      END IF;
    ELSIF p_type = 'image' THEN
      IF p_video_script IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_script_not_allowed';
      END IF;
      IF p_video_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_video_style_not_allowed';
      END IF;
      IF p_animation_style IS NOT NULL THEN
        RAISE EXCEPTION 'request_animation_style_not_allowed';
      END IF;
    END IF;

    IF p_type <> 'video' THEN
      IF p_duration_choice IS NOT NULL THEN
        RAISE EXCEPTION 'request_duration_choice_not_allowed'
          USING HINT = 'Only video requests carry a duration choice.';
      END IF;
      IF p_characters_speak IS NOT NULL THEN
        RAISE EXCEPTION 'request_characters_speak_not_allowed'
          USING HINT = 'Only video requests carry a characters-speak selection.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 7b. Child name validation
    --     Optional for every request type. Only a length ceiling is enforced
    --     here; the shape rules live with the form, and a historical row that
    --     predates the column simply stays NULL.
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_child_name IS NOT NULL AND char_length(trim(p_child_name)) > 60 THEN
      RAISE EXCEPTION 'request_child_name_too_long'
        USING HINT = 'Child name must not exceed 60 characters.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 8. Source file validation and MIME derivation
    -- ═══════════════════════════════════════════════════════════════════════════
    v_has_file := p_file_path IS NOT NULL;

    IF v_has_file THEN
      -- Reject leading slash (absolute path)
      IF p_file_path LIKE '/%' THEN
        RAISE EXCEPTION 'request_invalid_file_path'
          USING HINT = 'File path must not be absolute.';
      END IF;

      -- Reject path traversal
      IF p_file_path LIKE '%/../%' OR p_file_path LIKE '../%' OR p_file_path LIKE '%/..' OR p_file_path = '..' THEN
        RAISE EXCEPTION 'request_invalid_file_path'
          USING HINT = 'File path must not contain path traversal.';
      END IF;

      -- Path must start with <real-auth-uid>/<order-id>/
      -- v_user_id is derived from parent_profiles.user_id, so uploads are
      -- bound to the parent's real auth identity — never a client-supplied value.
      IF p_file_path NOT LIKE (v_user_id::text || '/' || p_order_id::text || '/%') THEN
        RAISE EXCEPTION 'request_invalid_file_path'
          USING HINT = 'File path must start with the authenticated user ID and order ID.';
      END IF;

      -- Verify the storage object exists and derive its MIME type
      SELECT metadata->>'mimetype' INTO v_trusted_mime
      FROM storage.objects
      WHERE bucket_id = 'parent-uploads'
        AND name = p_file_path;

      IF v_trusted_mime IS NULL THEN
        RAISE EXCEPTION 'request_file_not_found'
          USING HINT = 'Uploaded file not found in storage.';
      END IF;

      -- Must be an allowed image MIME type
      IF v_trusted_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
        RAISE EXCEPTION 'request_file_type_invalid'
          USING HINT = 'Source file must be JPEG, PNG, or WebP.';
      END IF;

      -- Drawing animation requires a source file
      IF p_type = 'drawing_animation' AND v_trusted_mime IS NULL THEN
        RAISE EXCEPTION 'request_file_required'
          USING HINT = 'Drawing animation requests require a source file.';
      END IF;
    ELSE
      -- Drawing animation requires a file
      IF p_type = 'drawing_animation' THEN
        RAISE EXCEPTION 'request_file_required'
          USING HINT = 'Drawing animation requests require a source file.';
      END IF;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 9. Derive pricing keys from validated request metadata
    --     Maps request type + duration + file presence to stable catalog keys.
    --     No numeric prices appear in this section.
    -- ═══════════════════════════════════════════════════════════════════════════
    IF p_type = 'image' THEN
      v_pricing_keys := CASE WHEN v_has_file
        THEN ARRAY['image.default', 'image.reference_file']
        ELSE ARRAY['image.default'] END;
    ELSIF p_type = 'video' THEN
      v_pricing_keys := CASE p_duration_key
        WHEN 'short' THEN ARRAY['video.short']
        WHEN 'medium' THEN ARRAY['video.medium']
        ELSE ARRAY['video.long'] END;
      IF v_has_file THEN
        v_pricing_keys := v_pricing_keys || ARRAY['video.reference_file'];
      END IF;
    ELSIF p_type = 'drawing_animation' THEN
      v_pricing_keys := CASE p_duration_key
        WHEN 'short' THEN ARRAY['drawing_animation.short']
        WHEN 'medium' THEN ARRAY['drawing_animation.medium']
        ELSE ARRAY['drawing_animation.long'] END;
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 10. Look up active catalog prices
    --     All required keys must exist, be active, and sum to a positive total.
    --     Missing / inactive / invalid pricing fails closed.
    -- ═══════════════════════════════════════════════════════════════════════════
    SELECT
      pg_catalog.count(*),
      pg_catalog.sum(cp.candy_cost)
    INTO
      v_found_count,
      v_candy_cost
    FROM public.creation_pricing AS cp
    WHERE cp.pricing_key = ANY(v_pricing_keys)
      AND cp.is_active = TRUE;

    IF v_found_count IS NULL OR v_found_count <> pg_catalog.cardinality(v_pricing_keys) THEN
      RAISE EXCEPTION 'CREATION_PRICING_UNAVAILABLE'
        USING HINT = 'قیمت این درخواست در حال حاضر در دسترس نیست.';
    END IF;

    IF v_candy_cost IS NULL OR v_candy_cost <= 0 THEN
      RAISE EXCEPTION 'CREATION_PRICING_UNAVAILABLE'
        USING HINT = 'قیمت این درخواست در حال حاضر در دسترس نیست.';
    END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 11. Wallet resolution and row lock
    -- ═══════════════════════════════════════════════════════════════════════════
    SELECT cw.id, cw.balance
    INTO v_wallet_id, v_wallet_balance
    FROM public.candy_wallets cw
    WHERE cw.parent_id = v_parent_id
    FOR UPDATE;

    IF v_wallet_id IS NULL THEN
      RAISE EXCEPTION 'CANDY_WALLET_NOT_FOUND'
        USING HINT = 'کیف پول آبنبات در دسترس نیست.';
    END IF;

    <<charge_and_create>>
    BEGIN
      -- ═════════════════════════════════════════════════════════════════════════
      -- 11b. Replay re-check, now that this parent's wallet row is locked.
      --      Every submission by one parent serialises on the wallet lock above.
      --      A concurrent call for the SAME submission_key that was ahead of us
      --      has therefore committed by now, and its order is visible here. Without
      --      this, the loser of that race would reach the balance check below
      --      AFTER the winner spent the last credit / candy and fail with
      --      INSUFFICIENT_* instead of replaying the winner's order. (The fast
      --      path in 1b ran before the lock and cannot see an order that was still
      --      in flight.) The ON CONFLICT insert further down remains the final
      --      guarantee; this only makes the loser answer correctly.
      -- ═════════════════════════════════════════════════════════════════════════
      IF p_submission_key IS NOT NULL THEN
        SELECT o.id INTO v_order_id
        FROM public.orders o
        WHERE o.parent_id = v_parent_id
          AND o.submission_key = p_submission_key;

        IF v_order_id IS NOT NULL THEN
          v_replayed := TRUE;
          EXIT charge_and_create;
        END IF;
      END IF;

      -- ═════════════════════════════════════════════════════════════════════════
      -- 12. Choose what pays for this request
      --     Welcome image credits are for IMAGE requests only and are spent
      --     BEFORE candy. Video and drawing animation never look at them. The
      --     parent does not choose. The credit row is locked FOR UPDATE (after
      --     the wallet row, always in that order) so two concurrent requests
      --     cannot both see the last credit.
      -- ═════════════════════════════════════════════════════════════════════════
      IF p_type = 'image' THEN
        SELECT (wc.granted_count - wc.used_count)
        INTO v_credit_left
        FROM public.parent_welcome_credits wc
        WHERE wc.parent_id = v_parent_id
        FOR UPDATE;

        IF COALESCE(v_credit_left, 0) > 0 THEN
          v_use_credit := TRUE;
        END IF;
      END IF;

      IF v_use_credit THEN
        v_pay_source := 'welcome_image_credit';
        v_charge := 0;
      ELSE
        v_pay_source := 'candy';
        v_charge := v_candy_cost;

        IF v_wallet_balance < v_candy_cost THEN
          RAISE EXCEPTION 'INSUFFICIENT_CANDIES'
            USING HINT = 'موجودی آبنبات شما کافی نیست.';
        END IF;
      END IF;

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 13. Insert order row
    --     candy_cost comes from the catalog lookup, never from the client.
    --     ON CONFLICT is the race-condition guard: if a concurrent call for
    --     the same (parent_id, submission_key) committed first, this INSERT
    --     is skipped rather than raising, and the branch below falls back to
    --     reading what the winner created. Nothing past this point runs for
    --     the loser — no media row, no wallet debit, no ledger entry — so a
    --     losing p_order_id never gains a row anywhere, which also means
    --     step 14 cannot legally insert a media_assets row against it (the
    --     foreign key alone would refuse that).
    -- ═══════════════════════════════════════════════════════════════════════════
    -- Aliased and the RETURNING column qualified as o.id: RETURNS TABLE above
    -- declares an OUT parameter named `id`, which plpgsql exposes as a
    -- variable in scope for the rest of the function body. An unqualified
    -- `RETURNING id` is ambiguous between that variable and orders.id; only
    -- the qualified form resolves to the column.
    INSERT INTO public.orders AS o (
      id,
      parent_id,
      type,
      status,
      title,
      description,
      character_id,
      candy_cost,
      child_name,
      submission_key,
      payment_source
    ) VALUES (
      p_order_id,
      v_parent_id,
      p_type,
      'pending_review',
      NULLIF(trim(COALESCE(p_title, '')), ''),
      trim(COALESCE(p_description, '')),
      p_character_id,
      v_charge,
      NULLIF(trim(COALESCE(p_child_name, '')), ''),
      p_submission_key,
      v_pay_source
    )
    ON CONFLICT (parent_id, submission_key) WHERE submission_key IS NOT NULL DO NOTHING
    RETURNING o.id INTO v_order_id;

    IF v_order_id IS NULL THEN
      -- Lost the race: another concurrent call for the same submission_key
      -- won and already committed. Fall back to its row; create nothing.
      SELECT o.id INTO v_order_id
      FROM public.orders o
      WHERE o.parent_id = v_parent_id
        AND o.submission_key = p_submission_key;

      v_replayed := TRUE;
    ELSE
      -- ═══════════════════════════════════════════════════════════════════════════
      -- 14. Insert media_assets row (when source file exists)
      -- ═══════════════════════════════════════════════════════════════════════════
      IF v_has_file THEN
        INSERT INTO public.media_assets (
          order_id,
          type,
          file_url,
          mime_type,
          original_filename
        ) VALUES (
          v_order_id,
          'upload',
          p_file_path,
          v_trusted_mime,
          -- The name the parent's own file had. The storage path carries a
          -- sanitized ASCII form, which is unreadable for a Persian file name, so
          -- the gallery label needs this to show anything recognisable. Capped to
          -- the column's own limit rather than relying on the caller.
          NULLIF(btrim(COALESCE(left(p_original_filename, 255), '')), '')
        );
      END IF;

      -- ═══════════════════════════════════════════════════════════════════════════
      -- 15. Insert type-specific extension row
      -- ═══════════════════════════════════════════════════════════════════════════
      IF p_type = 'video' THEN
        INSERT INTO public.video_requests (
          order_id,
          script,
          style,
          duration_choice,
          characters_speak
        ) VALUES (
          v_order_id,
          trim(p_video_script),
          NULLIF(trim(COALESCE(p_video_style, '')), ''),
          p_duration_choice,
          p_characters_speak
        );
      ELSIF p_type = 'drawing_animation' THEN
        INSERT INTO public.drawing_animation_requests (
          order_id,
          upload_url,
          animation_style
        ) VALUES (
          v_order_id,
          p_file_path,
          trim(p_animation_style)
        );
      END IF;

      -- ═══════════════════════════════════════════════════════════════════════════
      -- 16. Spend exactly one source, in the SAME transaction as the order insert
      --     above. Any error from here rolls the order back too, so a failed
      --     request can never leave a credit or candy consumed.
      -- ═══════════════════════════════════════════════════════════════════════════
      IF v_use_credit THEN
        -- Guarded decrement: refuses (0 rows) rather than ever exceeding the
        -- grant, even if a future code path forgot the lock.
        UPDATE public.parent_welcome_credits wc
        SET used_count = wc.used_count + 1
        WHERE wc.parent_id = v_parent_id
          AND wc.used_count < wc.granted_count;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'WELCOME_CREDIT_EXHAUSTED'
            USING HINT = 'No welcome image credit remains.';
        END IF;

        -- Separate, immutable record: "this image used a welcome credit".
        -- Deliberately NOT a candy_transactions row - no candy moved.
        INSERT INTO public.parent_welcome_credit_usages (parent_id, order_id)
        VALUES (v_parent_id, v_order_id);
      ELSE
        -- Candy path - behaviour unchanged: deduct the catalog price from the
        -- locked wallet, then append the immutable ledger row below.
        UPDATE public.candy_wallets cw
        SET balance = balance - v_candy_cost
        WHERE cw.id = v_wallet_id;

        -- ═══════════════════════════════════════════════════════════════════════════
        -- 17. Insert immutable ledger transaction
        --     type = order_debit, idempotency_key = 'order_debit:' || v_order_id.
        --     Kept as a second defence even though submission_key is now the
        --     primary guard: this insert only ever runs once per v_order_id,
        --     since v_order_id is only ever created once (the ON CONFLICT branch
        --     above never reaches here).
        -- ═══════════════════════════════════════════════════════════════════════════
        INSERT INTO public.candy_transactions (
          wallet_id,
          amount,
          type,
          reference_type,
          reference_id,
          description,
          idempotency_key
        ) VALUES (
          v_wallet_id,
          -v_candy_cost,
          'order_debit',
          'order',
          v_order_id,
          'مصرف آبنبات برای سفارش',
          'order_debit:' || v_order_id
        );
      END IF;
    END IF;
    END;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 18. Return the order — created just now, or replayed from an earlier
  --     attempt with the same submission_key. The client cannot tell, and
  --     does not need to: it always redirects to /dashboard/orders/<id>.
  -- ═══════════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT
    o.id,
    o.type,
    o.status,
    o.candy_cost,
    v_replayed,
    o.payment_source
  FROM public.orders o
  WHERE o.id = v_order_id;
END;
$$;

COMMENT ON FUNCTION public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
) IS
  'Trusted server-only parent request creation. Callable only by service_role. '
  'Idempotent per (parent_id, submission_key). Atomically inserts the order (and '
  'extensions) and spends exactly ONE payment source: for image requests a welcome '
  'image credit when one remains (no candy moves, no candy_transactions row), '
  'otherwise candy from the locked wallet with an immutable ledger entry. Video '
  'and drawing animation always use candy. Returns payment_source, which on a '
  'replay is the ORIGINAL order''s source. Pricing resolved exclusively from '
  'public.creation_pricing.';

REVOKE ALL ON FUNCTION public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
) FROM anon;

REVOKE ALL ON FUNCTION public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
) TO service_role;

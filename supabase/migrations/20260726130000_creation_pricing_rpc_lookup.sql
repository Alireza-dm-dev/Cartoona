-- Migration: creation_pricing_rpc_lookup
-- Replaces create_parent_request's hardcoded candy-price branches with
-- authoritative lookup from public.creation_pricing.
--
-- The existing function signature, validation, auth, RLS, error codes,
-- wallet locking, wallet deduction, and ledger insertion are preserved.
-- Only the pricing section changes — from hardcoded SQL constants to
-- catalog-based key resolution.
--
-- config/candy-costs.ts remains temporarily duplicated for UI display.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- Replace create_parent_request with catalog-based pricing lookup
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_parent_request(
  p_order_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_description TEXT DEFAULT NULL,
  p_character_id UUID DEFAULT NULL,
  p_duration_key TEXT DEFAULT NULL,
  p_video_script TEXT DEFAULT NULL,
  p_video_style TEXT DEFAULT NULL,
  p_animation_style TEXT DEFAULT NULL,
  p_file_path TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  type TEXT,
  status TEXT,
  candy_cost INTEGER
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
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Authentication check
  -- ═══════════════════════════════════════════════════════════════════════════
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_unauthenticated'
      USING HINT = 'Authentication required.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2. Parent role and consent check
  -- ═══════════════════════════════════════════════════════════════════════════
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

  -- Find the parent profile and verify consent
  SELECT pp.id INTO v_parent_id
  FROM public.parent_profiles pp
  WHERE pp.user_id = v_user_id;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'request_parent_profile_missing'
      USING HINT = 'Parent profile not found.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parent_profiles pp WHERE pp.id = v_parent_id AND pp.consent_granted = TRUE) THEN
    RAISE EXCEPTION 'request_consent_required'
      USING HINT = 'Parent consent must be granted.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3. Order ID validation
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'request_invalid_order_id'
      USING HINT = 'Order ID is required.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 4. Type validation
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_type NOT IN ('image', 'video', 'drawing_animation') THEN
    RAISE EXCEPTION 'request_invalid_type'
      USING HINT = 'Type must be image, video, or drawing_animation.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 5. Text validation
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_title IS NULL OR char_length(trim(p_title)) = 0 THEN
    RAISE EXCEPTION 'request_title_required'
      USING HINT = 'Title is required and must not be empty.';
  END IF;

  IF char_length(p_title) > 160 THEN
    RAISE EXCEPTION 'request_title_too_long'
      USING HINT = 'Title must not exceed 160 characters.';
  END IF;

  IF p_description IS NOT NULL AND char_length(p_description) > 5000 THEN
    RAISE EXCEPTION 'request_description_too_long'
      USING HINT = 'Description must not exceed 5000 characters.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 6. Character validation
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
  -- 7. Duration validation
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
  -- 8. Type-specific field validation
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
    IF p_video_style IS NULL OR char_length(trim(p_video_style)) = 0 THEN
      RAISE EXCEPTION 'request_style_required'
        USING HINT = 'Video style is required.';
    END IF;
    IF char_length(p_video_style) > 200 THEN
      RAISE EXCEPTION 'request_style_too_long'
        USING HINT = 'Video style must not exceed 200 characters.';
    END IF;
    IF p_animation_style IS NOT NULL THEN
      RAISE EXCEPTION 'request_animation_style_not_allowed'
        USING HINT = 'Video requests must not include an animation style.';
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

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 9. Source file validation and MIME derivation
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

    -- Path must start with <auth-uid>/<order-id>/
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
  -- 10. Derive pricing keys from validated request metadata
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
  -- 11. Look up active catalog prices
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
  -- 12. Wallet resolution and row lock
  --     Resolves the parent's wallet using parent_profiles → candy_wallets.
  --     Locks the row FOR UPDATE to serialize concurrent requests.
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

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 13. Insufficient balance check
  -- ═══════════════════════════════════════════════════════════════════════════
  IF v_wallet_balance < v_candy_cost THEN
    RAISE EXCEPTION 'INSUFFICIENT_CANDIES'
      USING HINT = 'موجودی آبنبات شما کافی نیست.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 14. Insert order row
  --     status = pending_review (not draft — parent has completed submission)
  --     moderation_status defaults to 'pending'
  --     assigned_admin_id defaults to null
  --     created_at / updated_at default to now()
  --     candy_cost comes from the catalog lookup, never from the client.
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO public.orders (
    id,
    parent_id,
    type,
    status,
    title,
    description,
    character_id,
    candy_cost
  ) VALUES (
    p_order_id,
    v_parent_id,
    p_type,
    'pending_review',
    trim(p_title),
    trim(COALESCE(p_description, '')),
    p_character_id,
    v_candy_cost
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 15. Insert media_assets row (when source file exists)
  -- ═══════════════════════════════════════════════════════════════════════════
  IF v_has_file THEN
    INSERT INTO public.media_assets (
      order_id,
      type,
      file_url,
      mime_type
    ) VALUES (
      p_order_id,
      'upload',
      p_file_path,
      v_trusted_mime
    );
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 16. Insert type-specific extension row
  -- ═══════════════════════════════════════════════════════════════════════════
  IF p_type = 'video' THEN
    INSERT INTO public.video_requests (
      order_id,
      script,
      style
    ) VALUES (
      p_order_id,
      trim(p_video_script),
      trim(p_video_style)
    );
  ELSIF p_type = 'drawing_animation' THEN
    INSERT INTO public.drawing_animation_requests (
      order_id,
      upload_url,
      animation_style
    ) VALUES (
      p_order_id,
      p_file_path,
      trim(p_animation_style)
    );
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 17. Deduct candy balance
  -- ═══════════════════════════════════════════════════════════════════════════
  UPDATE public.candy_wallets cw
  SET balance = balance - v_candy_cost
  WHERE cw.id = v_wallet_id;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 18. Insert immutable ledger transaction
  --     type = order_debit
  --     amount = -v_candy_cost (negative = debit)
  --     reference_type = 'order'
  --     reference_id = p_order_id
  --     idempotency_key = 'order_debit:' || p_order_id
  --     The partial unique index prevents duplicate debits for the same order.
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
    p_order_id,
    'مصرف آبنبات برای سفارش',
    'order_debit:' || p_order_id
  );

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 19. Return the created order
  -- ═══════════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT
    o.id,
    o.type,
    o.status,
    o.candy_cost
  FROM public.orders o
  WHERE o.id = p_order_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 20. Execution privileges (unchanged)
--     Only authenticated users may call the function.
--     anon and PUBLIC have no access.
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.create_parent_request(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.create_parent_request(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM anon;

GRANT EXECUTE ON FUNCTION public.create_parent_request(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

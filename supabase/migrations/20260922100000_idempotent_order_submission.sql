-- Migration: idempotent_order_submission
-- Makes the parent request-submission RPC idempotent per logical submit
-- attempt, so a retry, timeout, double click, or a repeated POST can never
-- create two orders, two candy debits, or two source-media rows for the same
-- logical submission.
--
-- Why:
--   orders.id (the storage-path anchor) has always been generated fresh by
--   the API route on every POST — including a retry of a request whose first
--   attempt actually succeeded but whose response was lost. Nothing tied two
--   attempts of the same logical submission together, so a retry after an
--   uncertain network result created a second order, a second candy debit,
--   and a second source-media row. The existing
--   `order_debit:<orderId>` ledger idempotency key never caught this: it is
--   keyed by the very id that changes on every retry, so it only ever guards
--   a single order_id from being debited twice, which could not happen
--   anyway.
--
-- Model:
--   An explicit client-generated UUID (`submission_key`), stable across the
--   first attempt and every retry of the same logical submit, sent as
--   `submissionKey` on every POST /api/requests. Uniqueness is scoped to the
--   parent: UNIQUE(parent_id, submission_key). The RPC checks for an existing
--   order under that (parent_id, submission_key) pair before creating one; if
--   found, it returns the existing order instead of creating another, and
--   creates nothing else (no media row, no wallet debit, no ledger entry).
--
--   The lookup happens twice for two different reasons:
--     1. A plain SELECT before any work, so the ordinary sequential retry
--        (the common case) short-circuits before pricing, the wallet lock, or
--        any insert — cheap and avoids re-running validation for nothing.
--     2. `INSERT ... ON CONFLICT (parent_id, submission_key) DO NOTHING`, so
--        two concurrent calls for the same (parent_id, submission_key) cannot
--        both create a row: Postgres serializes the conflicting inserts, the
--        loser's INSERT returns no row, and the loser falls back to reading
--        the row the winner just committed. The database's own unique index
--        is what makes this safe under real concurrency — the first SELECT is
--        an optimization, never the guarantee.
--   Historical rows are untouched: submission_key is nullable, defaults to
--   NULL, and the unique index only applies where it is not null.
--
-- Non-destructive: one new nullable column, one new partial unique index, one
-- new trailing optional RPC parameter. A caller that omits it (none should,
-- going forward) behaves exactly as before: no idempotency check runs.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The column and its uniqueness
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS submission_key UUID;

COMMENT ON COLUMN public.orders.submission_key IS
  'Client-generated idempotency key for one logical creation submit attempt. '
  'NULL for every order created before this column existed. Unique per parent '
  '(see orders_parent_submission_key_key) so a retried POST for the same '
  'attempt returns the existing order instead of creating another.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'orders_parent_submission_key_key'
  ) THEN
    CREATE UNIQUE INDEX orders_parent_submission_key_key
      ON public.orders (parent_id, submission_key)
      WHERE submission_key IS NOT NULL;
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Replace the trusted request-creation RPC
--    The parameter list grows by one optional trailing argument, so every
--    legitimate historical signature is dropped first — the convention
--    established in 20260915100000 / 20260918100000 / 20260918120000. Body is
--    the one from 20260918120000_request_source_original_filename.sql with
--    the idempotency check added ahead of validation and around the insert.
--    This migration owns the 16-argument signature.
-- ═════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.create_parent_request_trusted(  -- 11-arg
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
);

DROP FUNCTION IF EXISTS public.create_parent_request_trusted(  -- 13-arg
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN
);

DROP FUNCTION IF EXISTS public.create_parent_request_trusted(  -- 14-arg
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
);

DROP FUNCTION IF EXISTS public.create_parent_request_trusted(  -- 15-arg
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT
);

DROP FUNCTION IF EXISTS public.create_parent_request_trusted(  -- 16-arg
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
  replayed BOOLEAN
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

    -- ═══════════════════════════════════════════════════════════════════════════
    -- 12. Insufficient balance check
    -- ═══════════════════════════════════════════════════════════════════════════
    IF v_wallet_balance < v_candy_cost THEN
      RAISE EXCEPTION 'INSUFFICIENT_CANDIES'
        USING HINT = 'موجودی آبنبات شما کافی نیست.';
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
      submission_key
    ) VALUES (
      p_order_id,
      v_parent_id,
      p_type,
      'pending_review',
      NULLIF(trim(COALESCE(p_title, '')), ''),
      trim(COALESCE(p_description, '')),
      p_character_id,
      v_candy_cost,
      NULLIF(trim(COALESCE(p_child_name, '')), ''),
      p_submission_key
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
      -- 16. Deduct candy balance
      -- ═══════════════════════════════════════════════════════════════════════════
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
    v_replayed
  FROM public.orders o
  WHERE o.id = v_order_id;
END;
$$;

COMMENT ON FUNCTION public.create_parent_request_trusted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID
) IS
  'Trusted server-only parent request creation. Callable only by service_role. '
  'Accepts a verified parent_profile_id from the API route instead of relying '
  'on auth.uid(). Idempotent per (parent_id, submission_key): a repeated call '
  'for the same pair returns the existing order and creates nothing new, '
  'guarded by a partial unique index against concurrent duplicates. Otherwise '
  'atomically inserts the order (and extensions), locks and deducts the candy '
  'wallet, and appends an immutable ledger entry. Pricing resolved exclusively '
  'from public.creation_pricing. Title is optional; video requests additionally '
  'persist a duration choice and a characters-speak flag; an optional child '
  'name is persisted on the order for any request type; the source media row '
  'records the parent-supplied original file name.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Permissions — unchanged policy, reapplied to the new signature
-- ═════════════════════════════════════════════════════════════════════════════

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

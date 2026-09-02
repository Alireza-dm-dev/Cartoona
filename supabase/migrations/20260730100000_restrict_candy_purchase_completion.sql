-- Migration: restrict_candy_purchase_completion
-- Removes direct EXECUTE permission from browser-authenticated roles
-- for candy-purchase completion. Creates a trusted server-only RPC
-- that accepts a verified parent profile ID instead of relying on auth.uid().
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Trusted server-only completion function
--    Accepts p_parent_profile_id (verified by the API route) instead of
--    relying on auth.uid(). The API route authenticates the parent, resolves
--    the parent_profile_id, and passes it here.
--
--    Callable only by service_role (trusted server/database roles).
--    Browser-authenticated roles (anon, authenticated) cannot execute it.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.complete_candy_purchase_trusted(
  p_purchase_id UUID,
  p_parent_profile_id UUID,
  p_payment_reference TEXT
)
RETURNS TABLE (
  purchase_id     UUID,
  purchase_status TEXT,
  wallet_id       UUID,
  wallet_balance  INTEGER,
  ledger_entry_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_purchase_parent_id UUID;
  v_purchase_status    TEXT;
  v_candy_amount       INTEGER;
  v_wallet_id          UUID;
  v_ledger_id          UUID;
  v_existing_ledger_id UUID;
  v_credit_key         TEXT;
BEGIN
  -- ═════════════════════════════════════════════════════════════════════════
  -- 1. Lock purchase row FOR UPDATE
  -- ═════════════════════════════════════════════════════════════════════════
  SELECT parent_id, status, candy_amount
    INTO v_purchase_parent_id, v_purchase_status, v_candy_amount
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_not_found'
      USING HINT = 'Purchase record not found.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 2. Ownership verification
  --    The parent_profile_id was already verified by the API route through
  --    the authenticated session. We double-check the purchase belongs to
  --    this parent before proceeding.
  -- ═════════════════════════════════════════════════════════════════════════
  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'purchase_not_owner'
      USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 3. Status check — only pending purchases may be completed
  -- ═════════════════════════════════════════════════════════════════════════
  IF v_purchase_status IS DISTINCT FROM 'pending' THEN
    IF v_purchase_status = 'paid' THEN
      -- Idempotent return: already paid, return current state
      v_credit_key := 'purchase_credit:' || p_purchase_id;
      SELECT id INTO v_existing_ledger_id
      FROM public.candy_transactions
      WHERE idempotency_key = v_credit_key;

      IF v_existing_ledger_id IS NOT NULL THEN
        RETURN QUERY
        SELECT
          p_purchase_id,
          'paid'::TEXT,
          cw.id,
          cw.balance,
          v_existing_ledger_id
        FROM public.candy_wallets cw
        WHERE cw.parent_id = p_parent_profile_id;
        RETURN;
      END IF;
    END IF;

    RAISE EXCEPTION 'purchase_not_pending'
      USING HINT = 'Only pending purchases can be completed.';
  END IF;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 4. Mark purchase as paid
  -- ═════════════════════════════════════════════════════════════════════════
  UPDATE public.candy_purchases
  SET status = 'paid',
      payment_reference = COALESCE(p_payment_reference, payment_reference),
      paid_at = now()
  WHERE id = p_purchase_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 5. Lock wallet and credit balance
  -- ═════════════════════════════════════════════════════════════════════════
  SELECT id INTO v_wallet_id
  FROM public.candy_wallets
  WHERE parent_id = p_parent_profile_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'purchase_wallet_not_found'
      USING HINT = 'Candy wallet not found.';
  END IF;

  UPDATE public.candy_wallets
  SET balance = balance + v_candy_amount
  WHERE id = v_wallet_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 6. Insert immutable ledger entry
  -- ═════════════════════════════════════════════════════════════════════════
  v_credit_key := 'purchase_credit:' || p_purchase_id;

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
    v_candy_amount,
    'purchase',
    'candy_purchase',
    p_purchase_id::TEXT,
    'اعتبار آبنبات بسته خریداری شده',
    v_credit_key
  )
  RETURNING id INTO v_ledger_id;

  -- ═════════════════════════════════════════════════════════════════════════
  -- 7. Return updated state
  -- ═════════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT
    p_purchase_id,
    'paid'::TEXT,
    v_wallet_id,
    (SELECT balance FROM public.candy_wallets WHERE id = v_wallet_id),
    v_ledger_id;
END;
$$;

COMMENT ON FUNCTION public.complete_candy_purchase_trusted IS
  'Trusted server-only purchase completion. Callable only by service_role. '
  'Accepts a verified parent_profile_id from the API route instead of relying '
  'on auth.uid(). Forwards to wallet credit and immutable ledger insertion. '
  'Idempotent — calling again with the same purchase_id returns current state.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Revoke EXECUTE from browser-authenticated roles
--    Both the old (auth.uid()-based) function and the new trusted function
--    must be unreachable by browser-authenticated database sessions.
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.complete_candy_purchase(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_candy_purchase(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_candy_purchase(UUID, TEXT) FROM authenticated;

REVOKE ALL ON FUNCTION public.complete_candy_purchase_trusted(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_candy_purchase_trusted(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_candy_purchase_trusted(UUID, UUID, TEXT) FROM authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Grant EXECUTE to service_role only
--    The Next.js API route calls this function through an admin Supabase
--    client using the SUPABASE_SECRET_KEY (service_role key).
-- ═════════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION public.complete_candy_purchase_trusted(UUID, UUID, TEXT) TO service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Update function comments
-- ═════════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION public.complete_candy_purchase IS
  '[DEPRECATED — use complete_candy_purchase_trusted instead] '
  'Development-only simulation. No longer executable by browser-authenticated '
  'roles. The trusted server-only function complete_candy_purchase_trusted '
  'must be used instead. This function is preserved for migration history '
  'and will be removed in a future cleanup migration. '
  'REMOVE when real payment gateway is integrated.';

-- Migration: provider_neutral_payment_foundation
-- Prepares candy purchases for a real payment provider without integrating
-- any gateway. All provider-specific state is isolated in per-attempt rows
-- and a webhook-event dedup table. No provider HTTP, SDK, or webhook code.
--
-- Model (MVP):
--   candy_purchases      = one business purchase (may be retried)
--   payment_attempts     = one attempt to pay that purchase (retry/audit history)
--   payment_webhook_events = provider webhook dedup (duplicate detection)
--
-- Amount/currency authority is unchanged and remains on candy_purchases:
--   browser sends package_id only → server snapshots candy_amount/price_amount/
--   currency → attempts copy requested_amount/requested_currency from the
--   purchase snapshot. Wallet credit uses purchase.candy_amount.
--
-- Currency policy (documented): all stored amounts are INTEGER RIAL (IRR)
-- values. Do not convert, rename to toman, or rescale.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. payment_attempts — one row per attempt to pay a candy purchase
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id               UUID NOT NULL REFERENCES public.candy_purchases(id) ON DELETE CASCADE,
  provider                  TEXT NOT NULL CHECK (char_length(trim(provider)) > 0),
  status                    TEXT NOT NULL DEFAULT 'created'
                            CHECK (status IN (
                              'created',
                              'awaiting_payment',
                              'processing',
                              'verified',
                              'failed',
                              'cancelled',
                              'expired'
                            )),
  provider_session_id       TEXT,
  provider_transaction_id   TEXT,
  provider_payment_reference TEXT,
  checkout_url              TEXT,
  checkout_expires_at       TIMESTAMPTZ,
  requested_amount          INTEGER NOT NULL CHECK (requested_amount > 0),
  requested_currency        TEXT NOT NULL CHECK (char_length(trim(requested_currency)) > 0),
  verified_amount           INTEGER CHECK (verified_amount IS NULL OR verified_amount > 0),
  verified_currency         TEXT,
  provider_verified_at      TIMESTAMPTZ,
  failure_code              TEXT,
  failure_message_safe      TEXT CHECK (
                              failure_message_safe IS NULL
                              OR char_length(failure_message_safe) <= 500
                            ),
  attempt_number            INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key           TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at              TIMESTAMPTZ
);

COMMENT ON TABLE public.payment_attempts IS
  'One row per attempt to pay a candy purchase. A purchase may have multiple '
  'attempts; at most one may be verified. Attempt-level provider state (session, '
  'transaction, checkout URL, verification, failure) lives here, never on the '
  'purchase. Trusted server (service_role) creates and updates attempts only.';

COMMENT ON COLUMN public.payment_attempts.provider IS
  'Provider-neutral text name of the payment provider (e.g. zarinpal, nextpay). No SDK types stored.';
COMMENT ON COLUMN public.payment_attempts.status IS
  'created → awaiting_payment → processing → verified | failed | cancelled | expired.';
COMMENT ON COLUMN public.payment_attempts.provider_session_id IS
  'Provider checkout/session reference for this attempt. Unique per provider when present.';
COMMENT ON COLUMN public.payment_attempts.provider_transaction_id IS
  'Provider payment transaction reference. Unique per provider when present.';
COMMENT ON COLUMN public.payment_attempts.provider_payment_reference IS
  'Optional provider-issued payment reference (e.g. authority, invoice).';
COMMENT ON COLUMN public.payment_attempts.checkout_url IS
  'Provider redirect URL for this attempt. Never stored on candy_purchases.';
COMMENT ON COLUMN public.payment_attempts.requested_amount IS
  'Amount requested from provider, copied from candy_purchases.price_amount snapshot. Integer RIAL (IRR).';
COMMENT ON COLUMN public.payment_attempts.requested_currency IS
  'Currency requested from provider, copied from candy_purchases.currency snapshot. Currently IRR.';
COMMENT ON COLUMN public.payment_attempts.verified_amount IS
  'Amount confirmed by provider-side verification. Must equal purchase.price_amount to be verified. Integer RIAL (IRR).';
COMMENT ON COLUMN public.payment_attempts.verified_currency IS
  'Currency confirmed by provider-side verification. Must equal purchase.currency.';
COMMENT ON COLUMN public.payment_attempts.failure_code IS
  'Safe, stable failure code for support and display decisions (e.g. session_expired, declined).';
COMMENT ON COLUMN public.payment_attempts.failure_message_safe IS
  'Human-safe failure message. MUST NEVER contain raw secrets, full provider payloads, or card data.';
COMMENT ON COLUMN public.payment_attempts.attempt_number IS
  '1-based attempt ordinal within the purchase. UNIQUE per purchase.';
COMMENT ON COLUMN public.payment_attempts.idempotency_key IS
  'Server-side idempotency key for attempt creation. UNIQUE per purchase. Never timestamp-only.';
COMMENT ON COLUMN public.payment_attempts.completed_at IS
  'When the attempt reached a terminal status (verified/failed/cancelled/expired).';

-- Updated_at trigger (reuses public.set_updated_at)
DROP TRIGGER IF EXISTS payment_attempts_set_updated_at ON public.payment_attempts;
CREATE TRIGGER payment_attempts_set_updated_at
  BEFORE UPDATE ON public.payment_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. payment_attempts — uniqueness and lookup indexes
-- ═════════════════════════════════════════════════════════════════════════════

-- 2a. Unique attempt number per purchase
ALTER TABLE public.payment_attempts
  ADD CONSTRAINT payment_attempts_purchase_attempt_unique
  UNIQUE (purchase_id, attempt_number);

-- 2b. Provider-scoped session uniqueness (partial — only when present)
DROP INDEX IF EXISTS idx_payment_attempts_provider_session;
CREATE UNIQUE INDEX idx_payment_attempts_provider_session
  ON public.payment_attempts (provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

-- 2c. Provider-scoped transaction uniqueness (partial — only when present)
DROP INDEX IF EXISTS idx_payment_attempts_provider_transaction;
CREATE UNIQUE INDEX idx_payment_attempts_provider_transaction
  ON public.payment_attempts (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

-- 2d. At most one verified attempt per purchase
DROP INDEX IF EXISTS idx_payment_attempts_verified_once;
CREATE UNIQUE INDEX idx_payment_attempts_verified_once
  ON public.payment_attempts (purchase_id)
  WHERE status = 'verified';

-- 2e. Attempt-creation idempotency per purchase
ALTER TABLE public.payment_attempts
  ADD CONSTRAINT payment_attempts_purchase_idempotency_unique
  UNIQUE (purchase_id, idempotency_key);

-- 2f. Efficient lookups
CREATE INDEX IF NOT EXISTS idx_payment_attempts_purchase_id
  ON public.payment_attempts (purchase_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status
  ON public.payment_attempts (status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_created_at
  ON public.payment_attempts (created_at);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. payment_webhook_events — provider webhook deduplication
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           TEXT NOT NULL CHECK (char_length(trim(provider)) > 0),
  provider_event_id  TEXT NOT NULL CHECK (char_length(trim(provider_event_id)) > 0),
  event_type         TEXT NOT NULL CHECK (char_length(trim(event_type)) > 0),
  attempt_id         UUID REFERENCES public.payment_attempts(id) ON DELETE SET NULL,
  purchase_id        UUID REFERENCES public.candy_purchases(id) ON DELETE SET NULL,
  processing_status  TEXT NOT NULL DEFAULT 'received'
                     CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  failure_code       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_webhook_events IS
  'Deduplication table for provider webhook events. Check UNIQUE(provider, provider_event_id) '
  'BEFORE any financial mutation. Never stores raw payloads, signatures, secrets, or card data.';
COMMENT ON COLUMN public.payment_webhook_events.provider_event_id IS
  'Provider-issued unique event ID. Combined with provider it is unique.';
COMMENT ON COLUMN public.payment_webhook_events.attempt_id IS
  'Optional link to the payment attempt this event refers to (SET NULL if attempt removed).';
COMMENT ON COLUMN public.payment_webhook_events.purchase_id IS
  'Optional link to the purchase this event refers to (SET NULL if purchase removed).';
COMMENT ON COLUMN public.payment_webhook_events.processing_status IS
  'received → processed | ignored | failed. Set by trusted server after handling.';
COMMENT ON COLUMN public.payment_webhook_events.failure_code IS
  'Safe failure code if processing failed. Never raw provider payload.';

CREATE UNIQUE INDEX idx_payment_webhook_events_provider_event
  ON public.payment_webhook_events (provider, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_attempt_id
  ON public.payment_webhook_events (attempt_id);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_purchase_id
  ON public.payment_webhook_events (purchase_id);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_processing_status
  ON public.payment_webhook_events (processing_status);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. candy_purchases — minimal provider-neutral purchase-level fields
--    Attempt-level data (session id, transaction id, checkout URL) stays on
--    payment_attempts. Only fields with clear purchase-level meaning are added.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_purchases
  ADD COLUMN IF NOT EXISTS active_payment_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS payment_provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.candy_purchases.active_payment_attempt_id IS
  'ID of the current payment attempt for this purchase (pointer to payment_attempts).';
COMMENT ON COLUMN public.candy_purchases.payment_provider IS
  'Provider engaged for the current attempt (mirror of active attempt provider). NULL before a session is created.';
COMMENT ON COLUMN public.candy_purchases.provider_verified_at IS
  'When the purchase payment was verified by trusted server-to-server verification. NULL until verified.';
COMMENT ON COLUMN public.candy_purchases.expires_at IS
  'When the current checkout expires. NULL unless an active checkout exists.';
COMMENT ON COLUMN public.candy_purchases.cancelled_at IS
  'When the purchase was cancelled by the parent. NULL until cancelled.';
COMMENT ON COLUMN public.candy_purchases.failed_at IS
  'When the entire purchase was marked failed. NULL until failed.';

-- Two-step FK: add the constraint only after payment_attempts exists (same migration).
ALTER TABLE public.candy_purchases
  ADD CONSTRAINT candy_purchases_active_payment_attempt_fkey
  FOREIGN KEY (active_payment_attempt_id)
  REFERENCES public.payment_attempts(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_candy_purchases_active_payment_attempt_id
  ON public.candy_purchases (active_payment_attempt_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Purchase status model
--    Keep the existing business set and add 'expired' (checkout expiry visibility).
--    Transient provider states (awaiting_payment, processing, verified) belong
--    to payment_attempts, NOT to the purchase.
--
--    pending   → purchase created, no session yet / retry allowed
--    paid      → payment verified, wallet credited (terminal)
--    failed    → entire purchase marked failed (a new attempt may still be created)
--    cancelled → parent cancelled (terminal)
--    expired   → checkout session expired without payment (retry allowed)
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_purchases
  DROP CONSTRAINT IF EXISTS candy_purchases_status_check;

ALTER TABLE public.candy_purchases
  ADD CONSTRAINT candy_purchases_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'expired'));

COMMENT ON COLUMN public.candy_purchases.status IS
  'pending | paid | failed | cancelled | expired. Transient provider states live on payment_attempts.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. RLS — payment_attempts
--    Parents may READ attempts of their own purchases only.
--    No browser INSERT/UPDATE/DELETE. Writes happen only through trusted
--    service-role-only RPCs.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_attempts FROM anon;
REVOKE ALL ON public.payment_attempts FROM authenticated;

-- Parent: SELECT attempts belonging to own candy purchases
CREATE POLICY payment_attempts_select_own ON public.payment_attempts
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.candy_purchases cp
      WHERE cp.id = payment_attempts.purchase_id
        AND EXISTS (
          SELECT 1 FROM public.parent_profiles pp
          WHERE pp.id = cp.parent_id
            AND pp.user_id = auth.uid()
        )
    )
  );

-- Admin / super_admin: SELECT all attempts (read-only; no browser writes)
CREATE POLICY payment_attempts_select_admin ON public.payment_attempts
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

GRANT SELECT ON public.payment_attempts TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. RLS — payment_webhook_events
--    No browser access at all. Only trusted server/service roles may write.
--    Admin read is intentionally omitted in MVP.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_webhook_events FROM anon;
REVOKE ALL ON public.payment_webhook_events FROM authenticated;

-- No policies → every browser-role access is denied. service_role bypasses RLS.

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Trusted attempt-creation RPC (service_role only)
--    Foundation for a future POST /api/candy-purchases/[id]/pay endpoint.
--    Snapshot amounts are copied from the purchase, never from caller input.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_payment_attempt_trusted(
  p_purchase_id UUID,
  p_parent_profile_id UUID,
  p_provider TEXT,
  p_checkout_expires_at TIMESTAMPTZ,
  p_idempotency_key TEXT
)
RETURNS TABLE (
  id                        UUID,
  purchase_id               UUID,
  provider                  TEXT,
  status                    TEXT,
  provider_session_id       TEXT,
  provider_transaction_id   TEXT,
  provider_payment_reference TEXT,
  checkout_url              TEXT,
  checkout_expires_at       TIMESTAMPTZ,
  requested_amount          INTEGER,
  requested_currency        TEXT,
  verified_amount           INTEGER,
  verified_currency         TEXT,
  provider_verified_at      TIMESTAMPTZ,
  failure_code              TEXT,
  failure_message_safe      TEXT,
  attempt_number            INTEGER,
  idempotency_key           TEXT,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_purchase_parent_id UUID;
  v_purchase_status   TEXT;
  v_price_amount      INTEGER;
  v_currency          TEXT;
  v_next_attempt      INTEGER;
  v_attempt_id        UUID;
  v_existing_id       UUID;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- 1. Input validation (trusted server inputs, but never trust blindly)
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_purchase_id IS NULL THEN
    RAISE EXCEPTION 'attempt_purchase_required'
      USING HINT = 'Purchase ID is required.';
  END IF;

  IF p_parent_profile_id IS NULL THEN
    RAISE EXCEPTION 'attempt_parent_required'
      USING HINT = 'Parent profile ID is required.';
  END IF;

  IF p_provider IS NULL OR char_length(trim(p_provider)) = 0 THEN
    RAISE EXCEPTION 'attempt_provider_required'
      USING HINT = 'Payment provider is required.';
  END IF;

  IF p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'attempt_idempotency_required'
      USING HINT = 'Idempotency key is required.';
  END IF;

  IF char_length(trim(p_idempotency_key)) > 255 THEN
    RAISE EXCEPTION 'attempt_idempotency_too_long'
      USING HINT = 'Idempotency key must not exceed 255 characters.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 2. Lock purchase row FOR UPDATE (serializes attempt creation per purchase)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT parent_id, status, price_amount, currency
    INTO v_purchase_parent_id, v_purchase_status, v_price_amount, v_currency
  FROM public.candy_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt_purchase_not_found'
      USING HINT = 'Purchase record not found.';
  END IF;

  -- Ownership verification (defense in depth — server already resolved the profile)
  IF v_purchase_parent_id IS DISTINCT FROM p_parent_profile_id THEN
    RAISE EXCEPTION 'attempt_purchase_not_owner'
      USING HINT = 'This purchase does not belong to you.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 3. Idempotency — return the existing attempt for this (purchase, key)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_existing_id
  FROM public.payment_attempts
  WHERE purchase_id = p_purchase_id
    AND idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY
    SELECT pa.*
    FROM public.payment_attempts pa
    WHERE pa.id = v_existing_id;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 4. Purchase status check — paid and cancelled are terminal; failed and
  --    expired may be retried (a new attempt on the same business purchase).
  -- ═══════════════════════════════════════════════════════════════════════
  IF v_purchase_status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'attempt_purchase_not_retryable'
      USING HINT = 'This purchase cannot accept new payment attempts.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 5. Compute next attempt number (1-based, unique per purchase)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT COALESCE(MAX(attempt_number), 0) + 1
    INTO v_next_attempt
  FROM public.payment_attempts
  WHERE purchase_id = p_purchase_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 6. Insert attempt. Amounts/currency come from the purchase snapshot —
  --    NEVER from caller input. Status starts at 'created'.
  -- ═══════════════════════════════════════════════════════════════════════
  INSERT INTO public.payment_attempts (
    purchase_id,
    provider,
    status,
    requested_amount,
    requested_currency,
    checkout_expires_at,
    attempt_number,
    idempotency_key
  ) VALUES (
    p_purchase_id,
    trim(p_provider),
    'created',
    v_price_amount,
    v_currency,
    p_checkout_expires_at,
    v_next_attempt,
    p_idempotency_key
  )
  RETURNING id INTO v_attempt_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 7. Point the purchase at the new attempt and re-activate if retry.
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.candy_purchases
  SET active_payment_attempt_id = v_attempt_id,
      payment_provider = trim(p_provider),
      status = CASE WHEN v_purchase_status IN ('failed', 'expired') THEN 'pending' ELSE v_purchase_status END,
      expires_at = COALESCE(p_checkout_expires_at, expires_at),
      failed_at = NULL,
      cancelled_at = NULL
  WHERE id = p_purchase_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 8. Return the created attempt
  -- ═══════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT pa.*
  FROM public.payment_attempts pa
  WHERE pa.id = v_attempt_id;
END;
$$;

COMMENT ON FUNCTION public.create_payment_attempt_trusted IS
  'Trusted server-only payment-attempt creation. Callable only by service_role. '
  'Accepts a verified parent_profile_id and an idempotency key. Snapshot amounts '
  'are copied from the candy_purchases row (price_amount/currency), never from '
  'caller input. Creates a new attempt row (status=created) with the next unique '
  'attempt_number, and points the purchase at it. Idempotent — retrying with the '
  'same (purchase_id, idempotency_key) returns the existing attempt.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Trusted session-recording RPC (service_role only)
--    Saves the provider checkout/session reference AFTER provider returns it.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_payment_attempt_session_trusted(
  p_attempt_id UUID,
  p_provider_session_id TEXT,
  p_checkout_url TEXT,
  p_checkout_expires_at TIMESTAMPTZ
)
RETURNS TABLE (
  id                        UUID,
  purchase_id               UUID,
  provider                  TEXT,
  status                    TEXT,
  provider_session_id       TEXT,
  provider_transaction_id   TEXT,
  provider_payment_reference TEXT,
  checkout_url              TEXT,
  checkout_expires_at       TIMESTAMPTZ,
  requested_amount          INTEGER,
  requested_currency        TEXT,
  verified_amount           INTEGER,
  verified_currency         TEXT,
  provider_verified_at      TIMESTAMPTZ,
  failure_code              TEXT,
  failure_message_safe      TEXT,
  attempt_number            INTEGER,
  idempotency_key           TEXT,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt_status      TEXT;
  v_attempt_provider    TEXT;
  v_attempt_purchase_id UUID;
  v_attempt_session     TEXT;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- 1. Input validation
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'attempt_id_required'
      USING HINT = 'Attempt ID is required.';
  END IF;

  IF p_provider_session_id IS NULL OR char_length(trim(p_provider_session_id)) = 0 THEN
    RAISE EXCEPTION 'attempt_session_id_required'
      USING HINT = 'Provider session ID is required.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 2. Lock the attempt row FOR UPDATE
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT status, provider, purchase_id, provider_session_id
    INTO v_attempt_status, v_attempt_provider, v_attempt_purchase_id, v_attempt_session
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt_not_found'
      USING HINT = 'Payment attempt not found.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 3. Only a freshly created attempt may receive its first session.
  -- ═══════════════════════════════════════════════════════════════════════
  IF v_attempt_status IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'attempt_not_created'
      USING HINT = 'Only newly created attempts can record a provider session.';
  END IF;

  -- Reject session ID reuse on the same attempt
  IF v_attempt_session IS NOT NULL THEN
    RAISE EXCEPTION 'attempt_session_already_set'
      USING HINT = 'This attempt already has a provider session.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 4. Record the session and move the attempt to awaiting_payment.
  --    Unique (provider, provider_session_id) index rejects cross-attempt reuse.
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.payment_attempts
  SET provider_session_id = trim(p_provider_session_id),
      checkout_url = p_checkout_url,
      checkout_expires_at = COALESCE(p_checkout_expires_at, checkout_expires_at),
      status = 'awaiting_payment'
  WHERE id = p_attempt_id;

  -- Mirror expiry onto the purchase
  IF p_checkout_expires_at IS NOT NULL THEN
    UPDATE public.candy_purchases
    SET expires_at = p_checkout_expires_at
    WHERE id = v_attempt_purchase_id;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 5. Return the updated attempt
  -- ═══════════════════════════════════════════════════════════════════════
  RETURN QUERY
  SELECT pa.*
  FROM public.payment_attempts pa
  WHERE pa.id = p_attempt_id;
END;
$$;

COMMENT ON FUNCTION public.record_payment_attempt_session_trusted IS
  'Trusted server-only session recording. Callable only by service_role. '
  'Stores the provider checkout/session reference on a freshly created attempt '
  'and moves it to awaiting_payment. Provider session IDs are unique per provider '
  'via a partial unique index; session reuse is rejected.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. RPC execution privileges
--     Browser roles (anon, authenticated) never execute these functions.
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.create_payment_attempt_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_attempt_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_payment_attempt_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_attempt_trusted(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.record_payment_attempt_session_trusted(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_payment_attempt_session_trusted(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.record_payment_attempt_session_trusted(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_attempt_session_trusted(UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

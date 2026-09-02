-- Migration: harden_candy_wallet_ledger
-- Harden the candy wallet and transaction ledger with constraints,
-- RLS, immutability enforcement, and automated wallet provisioning.
-- =============================================================================

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. BACKFILL: One wallet per existing parent
-- ═════════════════════════════════════════════════════════════════════════════
-- Creates a candy_wallet for every parent_profiles row that does not
-- already have one.  Uses ON CONFLICT DO NOTHING so the migration is
-- safe to re-run if wallets already exist.
INSERT INTO public.candy_wallets (parent_id, balance)
SELECT pp.id, 0
FROM public.parent_profiles pp
WHERE NOT EXISTS (
  SELECT 1 FROM public.candy_wallets cw WHERE cw.parent_id = pp.id
)
ON CONFLICT (parent_id) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. WALLET PROVISIONING TRIGGER
-- ═════════════════════════════════════════════════════════════════════════════
-- Ensures every future parent user automatically receives a wallet.
-- The function is called from a trigger on parent_profiles (not public.users)
-- because candy_wallets.parent_id references parent_profiles.id.
-- When a new parent_profiles row is inserted, we insert a zero-balance wallet.
-- If a wallet already exists (e.g. from a backfill or manual creation),
-- the ON CONFLICT DO NOTHING leaves it untouched.

CREATE OR REPLACE FUNCTION public.ensure_parent_candy_wallet()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.candy_wallets (parent_id, balance)
  VALUES (NEW.id, 0)
  ON CONFLICT (parent_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.ensure_parent_candy_wallet()
IS 'Automatically creates a zero-balance candy wallet when a new parent profile is inserted. Idempotent — does nothing if a wallet already exists.';

DROP TRIGGER IF EXISTS ensure_parent_candy_wallet ON public.parent_profiles;
CREATE TRIGGER ensure_parent_candy_wallet
  AFTER INSERT ON public.parent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_parent_candy_wallet();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. TRANSACTION IMMUTABILITY TRIGGER
-- ═════════════════════════════════════════════════════════════════════════════
-- Makes candy_transactions append-only at the database level.
-- UPDATE and DELETE raise an exception.
-- Migration owners may DROP this trigger in a future migration when
-- a controlled schema repair is required.

CREATE OR REPLACE FUNCTION public.prevent_candy_transaction_mutation()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'candy_transactions is append-only; updates are not permitted';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'candy_transactions is append-only; deletes are not permitted';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.prevent_candy_transaction_mutation()
IS 'Prevents UPDATE and DELETE on candy_transactions to enforce append-only immutability. DROP this trigger in a future migration if a controlled schema repair is needed.';

DROP TRIGGER IF EXISTS prevent_candy_transaction_mutation ON public.candy_transactions;
CREATE TRIGGER prevent_candy_transaction_mutation
  BEFORE UPDATE OR DELETE ON public.candy_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_candy_transaction_mutation();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. TRANSACTION AMOUNT CONSTRAINT
-- ═════════════════════════════════════════════════════════════════════════════
-- Zero-amount transactions are meaningless in a ledger.
-- Existing valid rows are left unchanged.

ALTER TABLE public.candy_transactions
  DROP CONSTRAINT IF EXISTS candy_transactions_amount_check;

ALTER TABLE public.candy_transactions
  ADD CONSTRAINT candy_transactions_amount_check CHECK (amount <> 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. IDEMPOTENCY KEY
-- ═════════════════════════════════════════════════════════════════════════════
-- Allows trusted RPCs to prevent duplicate ledger entries when retried.
-- A partial unique index ensures at most one transaction per key.
-- The key must be generated server-side by the calling RPC, never accepted
-- from an untrusted browser client as financial authority.

ALTER TABLE public.candy_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

COMMENT ON COLUMN public.candy_transactions.idempotency_key
IS 'Server-generated unique key for idempotent ledger writes. NULL until the atomic-spend RPC is implemented.';

DROP INDEX IF EXISTS idx_candy_transactions_idempotency_key;
CREATE UNIQUE INDEX idx_candy_transactions_idempotency_key
  ON public.candy_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. ROW-LEVEL SECURITY — candy_wallets
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_wallets ENABLE ROW LEVEL SECURITY;

-- Revoke broad direct-mutation grants from browser roles
REVOKE ALL ON public.candy_wallets FROM anon;
REVOKE ALL ON public.candy_wallets FROM authenticated;

-- Re-grant only SELECT — parents read own, admins read all
GRANT SELECT ON public.candy_wallets TO authenticated;

-- Parent: SELECT own wallet (owner via parent_profiles → auth.uid())
CREATE POLICY candy_wallets_select_own ON public.candy_wallets
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.parent_profiles
      WHERE parent_profiles.id = candy_wallets.parent_id
      AND parent_profiles.user_id = auth.uid()
    )
  );

-- Admin / super_admin: SELECT all wallets
CREATE POLICY candy_wallets_select_admin ON public.candy_wallets
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. ROW-LEVEL SECURITY — candy_transactions
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.candy_transactions ENABLE ROW LEVEL SECURITY;

-- Revoke broad direct-mutation grants from browser roles
REVOKE ALL ON public.candy_transactions FROM anon;
REVOKE ALL ON public.candy_transactions FROM authenticated;

-- Re-grant only SELECT — parents read own, admins read all
GRANT SELECT ON public.candy_transactions TO authenticated;

-- Parent: SELECT only transactions belonging to their own wallet
-- Ownership resolved through candy_wallets → parent_profiles → auth.uid()
CREATE POLICY candy_transactions_select_own ON public.candy_transactions
  FOR SELECT
  TO authenticated
  USING (
    public.is_parent()
    AND EXISTS (
      SELECT 1 FROM public.candy_wallets
      INNER JOIN public.parent_profiles
        ON parent_profiles.id = candy_wallets.parent_id
      WHERE candy_wallets.id = candy_transactions.wallet_id
        AND parent_profiles.user_id = auth.uid()
    )
  );

-- Admin / super_admin: SELECT all transactions
CREATE POLICY candy_transactions_select_admin ON public.candy_transactions
  FOR SELECT
  TO authenticated
  USING (public.is_admin_or_super_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. FUNCTION EXECUTION GRANTS
-- ═════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.ensure_parent_candy_wallet() FROM PUBLIC;
-- Trigger-owned functions do not need explicit EXECUTE grants because
-- the trigger runs with the privileges of the trigger owner (postgres).

REVOKE ALL ON FUNCTION public.prevent_candy_transaction_mutation() FROM PUBLIC;
-- Same — trigger-owned function, no client EXECUTE needed.

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. UPDATED_AT TRIGGER — candy_wallets
-- ═════════════════════════════════════════════════════════════════════════════
-- The set_updated_at() function already exists from migration 20260717090000.
-- Apply it to candy_wallets so the updated_at column stays current.

DROP TRIGGER IF EXISTS candy_wallets_set_updated_at ON public.candy_wallets;
CREATE TRIGGER candy_wallets_set_updated_at
  BEFORE UPDATE ON public.candy_wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

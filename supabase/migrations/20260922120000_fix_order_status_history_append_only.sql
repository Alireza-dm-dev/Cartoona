-- Migration: fix_order_status_history_append_only
-- Fixes the append-only guard on public.order_status_history: the existing
-- trigger's condition never actually fired, so a direct UPDATE or DELETE with
-- the service-role key silently succeeded against what was documented as an
-- immutable audit trail.
--
-- Root cause:
--   The trigger (20260801120000_request_fulfilment_workflow.sql §1) checked
--   `pg_trigger_depth() = 0`, on the theory that a direct top-level UPDATE/
--   DELETE runs at depth 0 and only a cascaded one runs deeper. Rehearsed
--   directly against the disposable project (a debug trigger with
--   `RAISE NOTICE 'depth=%, op=%', pg_trigger_depth(), TG_OP`):
--
--     direct UPDATE order_status_history                    -> depth = 1
--     direct DELETE order_status_history                    -> depth = 1
--     DELETE FROM orders (FK ON DELETE CASCADE, confdeltype
--       'c' on order_status_history_order_id_fkey)           -> depth = 2
--
--   A trigger is always at least depth 1 while it is itself executing — `= 0`
--   can never be true inside this function, for any caller, so the exception
--   never raised for anything. Every FK hop in a legitimate cascade adds one
--   level of nesting, so any cascade (this one, or a deeper one such as
--   parent_profiles -> orders -> order_status_history) lands at depth >= 2,
--   strictly above a direct call's depth of 1. `pg_trigger_depth() <= 1` is
--   therefore the smallest predicate that reliably separates direct tampering
--   from legitimate cascade cleanup, and needs no other architecture change.
--
-- Fix:
--   - UPDATE is now unconditionally rejected (it never legitimately happens
--     to this table at any depth — no code path updates history rows).
--   - DELETE is rejected only at depth <= 1 (a direct call); a cascade
--     delete triggered by removing the parent order (or an ancestor of it)
--     is left to proceed, exactly as the original migration intended.
--   - TRUNCATE is unchanged: still always rejected (statement-level trigger,
--     no cascade concept applies to it).
--
-- Non-destructive: replaces the trigger function only (CREATE OR REPLACE).
-- No history rows are touched, no column/status semantics change, no grant
-- is broadened — REVOKE/GRANT on this table are untouched by this file.
-- Idempotent: CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS /
-- CREATE TRIGGER can both be re-run safely.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.order_status_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'order_status_history_append_only'
      USING HINT = 'History rows are append-only and the table cannot be truncated.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_status_history_append_only'
      USING HINT = 'History rows are append-only and cannot be updated.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- depth <= 1: this DELETE is the top-level statement (or was invoked
    -- directly with no other trigger above it) — reject it. depth > 1: this
    -- DELETE is running because an ancestor row (the order, or something
    -- above it) was deleted and the FK's ON DELETE CASCADE is cleaning up —
    -- let it proceed, so parent/order cleanup is never blocked.
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'order_status_history_append_only'
        USING HINT = 'History rows are append-only and cannot be deleted directly.';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.order_status_history_append_only IS
  'Enforces append-only on order_status_history. UPDATE is always rejected. '
  'DELETE is rejected only when invoked directly (pg_trigger_depth() <= 1); '
  'a DELETE running as part of an FK ON DELETE CASCADE from an ancestor row '
  '(e.g. deleting the order) runs at a strictly greater depth and is allowed '
  'to proceed, since order_status_history.order_id references orders(id) '
  'ON DELETE CASCADE. TRUNCATE is always rejected.';

-- Triggers already point at this function by name; only the function body
-- changed, so the triggers do not need to be recreated. Re-declared here
-- anyway, idempotently, so this migration fully describes the object it
-- fixes rather than relying on a prior migration's trigger still existing
-- unmodified.
DROP TRIGGER IF EXISTS order_status_history_append_only_trigger ON public.order_status_history;
CREATE TRIGGER order_status_history_append_only_trigger
  BEFORE UPDATE OR DELETE ON public.order_status_history
  FOR EACH ROW
  EXECUTE FUNCTION public.order_status_history_append_only();

DROP TRIGGER IF EXISTS order_status_history_truncate_block ON public.order_status_history;
CREATE TRIGGER order_status_history_truncate_block
  BEFORE TRUNCATE ON public.order_status_history
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.order_status_history_append_only();

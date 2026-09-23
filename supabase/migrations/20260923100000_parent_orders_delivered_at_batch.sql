-- =============================================================================
-- Migration: parent_orders_delivered_at_batch
-- Adds a batch-capable, parent-safe read of delivered timestamps so the
-- parent orders LIST can use the real order_status_history transition for
-- completedAt instead of orders.updated_at (which is touched by every status
-- change, not only delivery — the same reason the detail page already moved
-- to deliveredAt(history) in the Manual Final Media Delivery work).
--
-- Without this, the list would need one get_parent_order_status_history(...)
-- call per order (N+1). This adds exactly one function so the list can fetch
-- every visible order's delivered timestamp in a single round trip.
--
-- Security, matching get_parent_order_status_history's existing convention:
--   - SECURITY DEFINER with SET search_path = '', schema-qualified throughout.
--   - Ownership is enforced inside the function via current_parent_profile_id()
--     (parent_profiles row of auth.uid()), never a parent id supplied by the
--     caller — an order id belonging to another parent is silently excluded
--     from the result rather than erroring, so a mixed batch of the caller's
--     own ids and someone else's ids returns only the caller's own rows.
--   - Returns order_id + delivered_at only: no previous_status, no
--     internal_note, no parent_visible_note, no changed_by_user_id. Strictly
--     narrower than get_parent_order_status_history, which already omits
--     internal_note and actor identity but still returns per-row status/note
--     detail this batch path has no use for.
--   - At most one row per order_id: MIN(created_at) is used for the rare case
--     of more than one 'delivered' row for the same order, matching
--     deliveredAt() in timeline-mapping.ts (earliest delivered transition —
--     "the moment it first became ready" — not the most recent one), so list
--     and detail can never disagree for the same order.
--   - REVOKE ALL FROM PUBLIC/anon, GRANT EXECUTE TO authenticated only — same
--     grant shape as every other parent-safe read function in this schema.
--
-- Non-destructive: adds one function only. No table, column, grant on
-- order_status_history/orders, or existing function is altered. Idempotent:
-- CREATE OR REPLACE FUNCTION can be re-run safely.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_parent_orders_delivered_at(p_order_ids UUID[])
RETURNS TABLE (
  order_id     UUID,
  delivered_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h.order_id, MIN(h.created_at) AS delivered_at
  FROM public.order_status_history h
  JOIN public.orders o ON o.id = h.order_id
  WHERE h.order_id = ANY(p_order_ids)
    AND h.new_status = 'delivered'
    AND o.parent_id = public.current_parent_profile_id()
  GROUP BY h.order_id
$$;

COMMENT ON FUNCTION public.get_parent_orders_delivered_at IS
  'Batch, parent-safe read of the earliest delivered transition per order, '
  'restricted to orders owned by the caller (current_parent_profile_id()). '
  'Returns order_id + delivered_at only — no status detail, no notes, no '
  'actor identity. An id in p_order_ids that the caller does not own is '
  'silently excluded, never raised. Lets the parent orders list compute '
  'completedAt in one call instead of one get_parent_order_status_history '
  'call per order.';

REVOKE ALL ON FUNCTION public.get_parent_orders_delivered_at(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_parent_orders_delivered_at(UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_parent_orders_delivered_at(UUID[]) TO authenticated;

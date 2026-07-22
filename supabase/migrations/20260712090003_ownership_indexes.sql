-- Migration: 00003_ownership_indexes
-- Creates indexes on foreign-key columns used by parent-ownership RLS policies.
-- These columns are not automatically indexed (PostgreSQL does not index FKs).
-- Columns already covered by UNIQUE constraints are intentionally skipped.

CREATE INDEX idx_child_profiles_parent_id ON public.child_profiles(parent_id);

CREATE INDEX idx_orders_parent_id ON public.orders(parent_id);

CREATE INDEX idx_media_assets_order_id ON public.media_assets(order_id);

CREATE INDEX idx_candy_transactions_wallet_id ON public.candy_transactions(wallet_id);

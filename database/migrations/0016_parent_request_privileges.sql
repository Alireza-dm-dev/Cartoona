-- Cartoona plain-PostgreSQL (V0.1.50) - request submission on the app role
--
-- POST /v1/parent/requests (lib/repositories/parent-requests.ts) runs
--
--   SELECT * FROM public.create_parent_request_trusted($1 ... $17)
--
-- the function created in 0005 (a line-for-line port of the Supabase RPC; the
-- only differences are the consent clause, which here reads the authoritative
-- parent_profiles.consent_granted, and the source-file MIME, which the backend
-- passes in instead of the function reading the storage provider).
--
-- This migration changes NO function body. It adds the two privileges the
-- route needs and nothing else:
--
--   1. EXECUTE on create_parent_request_trusted. 0007 revoked EXECUTE from
--      PUBLIC on every function, so until now no role could call it. This is
--      the ONLY write capability the app role gets for requests: it still
--      cannot INSERT/UPDATE orders, video_requests, drawing_animation_requests,
--      media_assets, candy_wallets, candy_transactions, parent_welcome_credits
--      or parent_welcome_credit_usages, and it cannot execute any other
--      financial function (complete_candy_purchase_trusted, coupon and payment
--      functions, update_order_status_trusted, ...). The function is SECURITY
--      DEFINER with an empty search_path, so it writes as its owner.
--
--   2. SELECT on characters. The request body names a character (the public
--      creation forms store the NAME); the route turns it into the id the
--      function validates. characters is public reference data (Supabase
--      served it to signed-out visitors); it holds no account data. Seeded with fresh ids
--      (0008), so the ids differ from Supabase's: the NAME is the shared key.
--
-- Reads the route already has: users, parent_profiles, orders (the
-- submission-key lookup is `parent_id = $1 AND submission_key = $2`),
-- creation_pricing, candy_wallets, parent_welcome_credits.

REVOKE ALL ON FUNCTION public.create_parent_request_trusted(uuid, uuid, text, text, text, uuid, text, text, text, text, text, text, boolean, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_parent_request_trusted(uuid, uuid, text, text, text, uuid, text, text, text, text, text, text, boolean, text, text, uuid, text) TO cartoona_app;

GRANT SELECT ON public.characters TO cartoona_app;

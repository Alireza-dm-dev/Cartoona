-- Cartoona plain-PostgreSQL (V0.1.47) - first application write: the parent's display name
--
-- PATCH /v1/parent/profile updates the signed-in parent's own full_name
-- (lib/repositories/parent-profiles.ts updateParentProfileName):
--
--   UPDATE public.parent_profiles SET full_name = $2, updated_at = now()
--   WHERE user_id = $1 RETURNING full_name
--
-- Column-level privilege only: cartoona_app may change full_name and
-- updated_at and NO other column (not user_id, consent, referral_code, id,
-- created_at). No INSERT, no DELETE, no table-wide UPDATE. The WHERE and
-- RETURNING use columns it can already SELECT (0009). The existing CHECK
-- (NULL or non-blank) and the referral-code trigger stay in force for it.
-- Ownership (WHERE user_id = the authenticated user) is enforced by the
-- repository; the backend never takes a user or profile id from the caller.

GRANT UPDATE (full_name, updated_at) ON public.parent_profiles TO cartoona_app;

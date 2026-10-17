-- Cartoona plain-PostgreSQL (V0.1.42) - identity resolution read grant
--
-- The backend resolves a verified external identity (provider, subject) to a
-- Cartoona user through public.user_identities, joined to public.users (which
-- cartoona_app can already SELECT, 0009). This is the only new privilege:
-- read-only, one table. Identity linking (INSERT) is not granted: V0.1.42
-- never creates users or identities on the fly, and signup moves later with
-- its own, explicit grant.

GRANT SELECT ON public.user_identities TO cartoona_app;

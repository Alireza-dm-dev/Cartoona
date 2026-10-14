-- Cartoona plain-PostgreSQL baseline (V0.1.38) - Cartoona-owned identity
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- public.users is Cartoona's user table. It used to take its primary key from
-- the Supabase auth user (FK, ON DELETE CASCADE) and was filled by a trigger on
-- that table. Here it stands alone: the backend inserts users itself, and a new
-- user gets a generated id. Migrated users keep their existing id unchanged.
ALTER TABLE public.users ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Which external identity a Cartoona user signs in with. Provider-neutral: the
-- data copy records each existing account as ('supabase', <auth user id>), and
-- a later provider adds its own rows without touching public.users.
CREATE TABLE public.user_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identities_pkey PRIMARY KEY (id),
    CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, provider_subject),
    CONSTRAINT user_identities_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
    CONSTRAINT user_identities_subject_check CHECK (char_length(provider_subject) BETWEEN 1 AND 255)
);

CREATE INDEX user_identities_user_id_idx ON public.user_identities USING btree (user_id);

COMMENT ON TABLE public.user_identities IS
  'External sign-in identities. unique(provider, provider_subject): one external account maps to exactly one Cartoona user. Credentials (passwords, OTP, phone verification) live with the provider, never here.';

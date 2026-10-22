-- Cartoona plain-PostgreSQL (V0.1.47) - one-time nonces for internal write assertions
--
-- Every backend WRITE carries a v3 internal assertion (lib/identity/assertion.ts)
-- with a 32-byte random nonce. The backend consumes that nonce here, exactly
-- once, before the write runs. A second request with the same assertion -
-- replayed, retried by the transport, or sent twice concurrently - finds the
-- nonce already consumed and is refused (409 replayed_request).
--
-- What is stored: the opaque nonce, the assertion's expiry, the request id and
-- the consumption time. No user id, provider subject, path or body: the table
-- answers only "has this nonce been used", nothing about who used it.
--
-- Privilege: cartoona_app gets EXECUTE on consume_internal_write_nonce() and
-- NOTHING on the table (no SELECT, INSERT, UPDATE or DELETE). The function is
-- SECURITY DEFINER (owner's rights) with an empty search_path, like the
-- *_trusted functions in 0005, so the only possible write is "insert this
-- nonce if it is new".
--
-- Race safety: the PRIMARY KEY plus INSERT ... ON CONFLICT DO NOTHING. Two
-- concurrent calls with the same nonce serialize on the key; exactly one
-- inserts a row (returns true), every other one inserts nothing (false).
--
-- Expiry and cleanup: a nonce is only useful while its assertion is valid
-- (<= 60 s). The function refuses an expires_at more than 5 minutes in the
-- past or the future (clock skew between hosts is bounded far below that), and
-- each call deletes rows that expired more than 10 minutes ago. A purged
-- nonce can therefore never be consumed again: its assertion is long expired,
-- and this function would refuse its expires_at anyway. The expires_at index
-- keeps the purge cheap; no scheduler is needed.

CREATE TABLE public.internal_write_nonces (
    nonce text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    request_id text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT internal_write_nonces_pkey PRIMARY KEY (nonce),
    CONSTRAINT internal_write_nonces_nonce_check CHECK ((nonce ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT internal_write_nonces_request_id_check CHECK ((request_id ~ '^[A-Za-z0-9._-]{8,64}$'::text))
);

CREATE INDEX internal_write_nonces_expires_at_idx ON public.internal_write_nonces USING btree (expires_at);

COMMENT ON TABLE public.internal_write_nonces IS 'Consumed one-time nonces of v3 internal write assertions. Opaque values only; written solely by consume_internal_write_nonce().';

CREATE FUNCTION public.consume_internal_write_nonce(p_nonce text, p_expires_at timestamp with time zone, p_request_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'invalid nonce' USING ERRCODE = '22023';
  END IF;
  IF p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9._-]{8,64}$' THEN
    RAISE EXCEPTION 'invalid request id' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL
     OR p_expires_at < pg_catalog.now() - interval '5 minutes'
     OR p_expires_at > pg_catalog.now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'nonce expiry out of range' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.internal_write_nonces
  WHERE expires_at < pg_catalog.now() - interval '10 minutes';

  INSERT INTO public.internal_write_nonces (nonce, expires_at, request_id)
  VALUES (p_nonce, p_expires_at, p_request_id)
  ON CONFLICT (nonce) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

COMMENT ON FUNCTION public.consume_internal_write_nonce(text, timestamp with time zone, text) IS 'Consumes a v3 write-assertion nonce exactly once: true the first time, false for any reuse (including concurrent). Purges rows expired > 10 minutes.';

REVOKE ALL ON TABLE public.internal_write_nonces FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_internal_write_nonce(text, timestamp with time zone, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_internal_write_nonce(text, timestamp with time zone, text) TO cartoona_app;

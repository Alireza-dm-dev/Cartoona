-- Cartoona plain-PostgreSQL baseline (V0.1.38) - helper functions, trigger functions, triggers
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- ══ Helper functions ══

CREATE FUNCTION public.calculate_coupon_discount(p_discount_type text, p_discount_value integer, p_original_price integer, p_maximum_discount_amount integer) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_discount INTEGER;
BEGIN
  IF p_discount_type = 'percentage' THEN
    v_discount := (p_original_price * p_discount_value) / 10000;
  ELSE
    v_discount := LEAST(p_discount_value, p_original_price);
  END IF;

  IF p_maximum_discount_amount IS NOT NULL AND v_discount > p_maximum_discount_amount THEN
    v_discount := p_maximum_discount_amount;
  END IF;

  RETURN v_discount;
END;
$$;

CREATE FUNCTION public.check_referral_binding_rate_limit(p_parent_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_now TIMESTAMPTZ;
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_now := pg_catalog.now();

  INSERT INTO public.referral_binding_rate_limits (parent_id, window_started_at, attempt_count)
  VALUES (p_parent_id, v_now, 1)
  ON CONFLICT (parent_id) DO UPDATE SET
    window_started_at = CASE
      WHEN pg_catalog.now() - referral_binding_rate_limits.window_started_at > INTERVAL '1 minute'
        THEN v_now
      ELSE referral_binding_rate_limits.window_started_at
    END,
    attempt_count = CASE
      WHEN pg_catalog.now() - referral_binding_rate_limits.window_started_at > INTERVAL '1 minute'
        THEN 1
      ELSE referral_binding_rate_limits.attempt_count + 1
    END,
    updated_at = v_now
  RETURNING attempt_count INTO v_count;

  RETURN v_count <= 5;
END;
$$;

COMMENT ON FUNCTION public.check_referral_binding_rate_limit IS 'Atomically checks and records a referral binding attempt. Returns TRUE when allowed (≤5 attempts per minute), FALSE when rate-limited.';

CREATE FUNCTION public.generate_parent_referral_code() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_code TEXT;
  v_attempt INT := 0;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 20 THEN
      RAISE EXCEPTION 'ERR_REFERRAL_CODE_EXHAUSTED'
        USING HINT = 'Could not generate a unique referral code after 20 attempts.';
    END IF;

    v_code := 'CT' || pg_catalog.upper(pg_catalog.encode(public.gen_random_bytes(6), 'hex'));

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.parent_profiles WHERE referral_code = v_code
    );
  END LOOP;

  RETURN v_code;
END;
$$;

COMMENT ON FUNCTION public.generate_parent_referral_code IS 'Generates a unique parent referral code (CT + 12 uppercase hex chars). Retries up to 20 times on collision.';

CREATE FUNCTION public.is_admin_user_id(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND role IN ('admin', 'super_admin')
  );
$$;

CREATE FUNCTION public.normalize_referral_code(p_code text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
DECLARE
  v_normalized TEXT;
BEGIN
  IF p_code IS NULL THEN
    RETURN NULL;
  END IF;

  v_normalized := pg_catalog.btrim(p_code);

  -- Convert Persian digits (U+06F0–U+06F9)
  v_normalized := pg_catalog.translate(v_normalized,
    chr(x'06F0'::int) || chr(x'06F1'::int) || chr(x'06F2'::int) || chr(x'06F3'::int) ||
    chr(x'06F4'::int) || chr(x'06F5'::int) || chr(x'06F6'::int) || chr(x'06F7'::int) ||
    chr(x'06F8'::int) || chr(x'06F9'::int),
    '0123456789');

  -- Convert Arabic digits (U+0660–U+0669)
  v_normalized := pg_catalog.translate(v_normalized,
    chr(x'0660'::int) || chr(x'0661'::int) || chr(x'0662'::int) || chr(x'0663'::int) ||
    chr(x'0664'::int) || chr(x'0665'::int) || chr(x'0666'::int) || chr(x'0667'::int) ||
    chr(x'0668'::int) || chr(x'0669'::int),
    '0123456789');

  -- Convert to uppercase
  v_normalized := pg_catalog.upper(v_normalized);

  -- Validate pattern
  IF v_normalized ~ '^CT[0-9A-F]{12}$' THEN
    RETURN v_normalized;
  END IF;

  RETURN NULL;
END;
$_$;

COMMENT ON FUNCTION public.normalize_referral_code IS 'Normalizes a referral code: trims, converts Persian/Arabic digits to ASCII, uppercases, and validates format. Returns NULL for invalid input.';

-- ══ Trigger functions ══

CREATE FUNCTION public.assign_parent_referral_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  NEW.referral_code := public.generate_parent_referral_code();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assign_parent_referral_code IS 'BEFORE INSERT trigger on parent_profiles — generates and assigns a referral code, ignoring any client-supplied value.';

CREATE FUNCTION public.ensure_parent_candy_wallet() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.candy_wallets (parent_id, balance)
  VALUES (NEW.id, 0)
  ON CONFLICT (parent_id) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ensure_parent_candy_wallet IS 'Automatically creates a zero-balance candy wallet when a new parent profile is inserted. Idempotent — does nothing if a wallet already exists.';

CREATE FUNCTION public.grant_parent_welcome_image_credits() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = NEW.user_id AND u.role = 'parent' AND u.deleted_at IS NULL
  ) THEN
    INSERT INTO public.parent_welcome_credits (parent_id, granted_count, used_count)
    VALUES (NEW.id, 3, 0)
    ON CONFLICT (parent_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.grant_parent_welcome_image_credits IS 'Grants the one-time 3 welcome image credits when a parent profile is created. Idempotent: PRIMARY KEY(parent_id) + ON CONFLICT DO NOTHING.';

CREATE FUNCTION public.order_status_history_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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

COMMENT ON FUNCTION public.order_status_history_append_only IS 'Enforces append-only on order_status_history. UPDATE is always rejected. DELETE is rejected only when invoked directly (pg_trigger_depth() <= 1); a DELETE running as part of an FK ON DELETE CASCADE from an ancestor row (e.g. deleting the order) runs at a strictly greater depth and is allowed to proceed, since order_status_history.order_id references orders(id) ON DELETE CASCADE. TRUNCATE is always rejected.';

CREATE FUNCTION public.prevent_candy_transaction_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'candy_transactions is append-only; updates are not permitted';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'candy_transactions is append-only; deletes are not permitted';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.prevent_candy_transaction_mutation IS 'Prevents UPDATE and DELETE on candy_transactions to enforce append-only immutability. DROP this trigger in a future migration if a controlled schema repair is needed.';

CREATE FUNCTION public.prevent_parent_referral_code_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    RAISE EXCEPTION 'ERR_PARENT_REFERRAL_CODE_IMMUTABLE'
      USING HINT = 'Referral code is permanent and cannot be changed.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_parent_referral_code_change IS 'BEFORE UPDATE trigger on parent_profiles — prevents changes to the referral_code column.';

CREATE FUNCTION public.prevent_settings_history_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  RAISE EXCEPTION 'referral_program_settings_history is immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ══ Triggers ══

CREATE TRIGGER assign_parent_referral_code BEFORE INSERT ON public.parent_profiles FOR EACH ROW EXECUTE FUNCTION public.assign_parent_referral_code();

CREATE TRIGGER candy_packages_set_updated_at BEFORE UPDATE ON public.candy_packages FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER candy_purchases_set_updated_at BEFORE UPDATE ON public.candy_purchases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER candy_wallets_set_updated_at BEFORE UPDATE ON public.candy_wallets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER coupons_set_updated_at BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER creation_pricing_set_updated_at BEFORE UPDATE ON public.creation_pricing FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER ensure_parent_candy_wallet AFTER INSERT ON public.parent_profiles FOR EACH ROW EXECUTE FUNCTION public.ensure_parent_candy_wallet();

CREATE TRIGGER examples_set_updated_at BEFORE UPDATE ON public.examples FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER grant_parent_welcome_image_credits AFTER INSERT ON public.parent_profiles FOR EACH ROW EXECUTE FUNCTION public.grant_parent_welcome_image_credits();

CREATE TRIGGER homepage_content_set_updated_at BEFORE UPDATE ON public.homepage_content FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER homepage_hero_layout_set_updated_at BEFORE UPDATE ON public.homepage_hero_layout FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER homepage_media_assets_set_updated_at BEFORE UPDATE ON public.homepage_media_assets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER media_assets_set_updated_at BEFORE UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER order_status_history_append_only_trigger BEFORE DELETE OR UPDATE ON public.order_status_history FOR EACH ROW EXECUTE FUNCTION public.order_status_history_append_only();

CREATE TRIGGER order_status_history_truncate_block BEFORE TRUNCATE ON public.order_status_history FOR EACH STATEMENT EXECUTE FUNCTION public.order_status_history_append_only();

CREATE TRIGGER parent_welcome_credits_set_updated_at BEFORE UPDATE ON public.parent_welcome_credits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER payment_attempts_set_updated_at BEFORE UPDATE ON public.payment_attempts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER prevent_candy_transaction_mutation BEFORE DELETE OR UPDATE ON public.candy_transactions FOR EACH ROW EXECUTE FUNCTION public.prevent_candy_transaction_mutation();

CREATE TRIGGER prevent_parent_referral_code_change BEFORE UPDATE OF referral_code ON public.parent_profiles FOR EACH ROW EXECUTE FUNCTION public.prevent_parent_referral_code_change();

CREATE TRIGGER referral_program_settings_set_updated_at BEFORE UPDATE ON public.referral_program_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_prevent_settings_history_delete BEFORE DELETE ON public.referral_program_settings_history FOR EACH ROW EXECUTE FUNCTION public.prevent_settings_history_mutation();

CREATE TRIGGER trg_prevent_settings_history_update BEFORE UPDATE ON public.referral_program_settings_history FOR EACH ROW EXECUTE FUNCTION public.prevent_settings_history_mutation();

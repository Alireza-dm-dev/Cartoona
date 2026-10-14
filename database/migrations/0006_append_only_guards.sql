-- Cartoona plain-PostgreSQL baseline (V0.1.38) - append-only guards
--
-- Derived from the FINAL state of supabase/migrations (applied in order to a
-- stubbed local PostgreSQL 17 and dumped), with every dependency on Supabase
-- Auth, Storage, RLS and database roles removed. See docs/PLAIN_POSTGRES.md.
-- The historical Supabase migrations are untouched and still drive production.

-- In Supabase these tables were append-only only because of RLS and grants:
-- no policy allowed UPDATE or DELETE. Plain PostgreSQL has neither, so the
-- guarantee becomes a trigger, following order_status_history: direct UPDATE,
-- DELETE and TRUNCATE are refused; a DELETE cascading from a deleted parent row
-- (pg_trigger_depth() > 1) is allowed so account cleanup is never blocked.
CREATE FUNCTION public.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '%_append_only', TG_TABLE_NAME
      USING HINT = 'Rows are append-only and the table cannot be truncated.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '%_append_only', TG_TABLE_NAME
      USING HINT = 'Rows are append-only and cannot be updated.';
  END IF;

  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION '%_append_only', TG_TABLE_NAME
      USING HINT = 'Rows are append-only and cannot be deleted directly.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.append_only_guard IS
  'Shared append-only trigger: refuses direct UPDATE/DELETE/TRUNCATE, allows FK-cascade deletes.';

CREATE TRIGGER audit_logs_append_only BEFORE DELETE OR UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
CREATE TRIGGER audit_logs_truncate_block BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.append_only_guard();

CREATE TRIGGER moderation_logs_append_only BEFORE DELETE OR UPDATE ON public.moderation_logs
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
CREATE TRIGGER moderation_logs_truncate_block BEFORE TRUNCATE ON public.moderation_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.append_only_guard();

CREATE TRIGGER parent_welcome_credit_usages_append_only BEFORE DELETE OR UPDATE ON public.parent_welcome_credit_usages
  FOR EACH ROW EXECUTE FUNCTION public.append_only_guard();
CREATE TRIGGER parent_welcome_credit_usages_truncate_block BEFORE TRUNCATE ON public.parent_welcome_credit_usages
  FOR EACH STATEMENT EXECUTE FUNCTION public.append_only_guard();

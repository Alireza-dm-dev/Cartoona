/**
 * PostgreSQL error normalisation.
 *
 * node-postgres throws errors that carry the raw server message, the failing
 * constraint, sometimes the offending row (`detail`) and, for connection
 * failures, the target address. None of that may reach a client. Everything
 * the data-access layer throws is therefore a `DbError` whose `message` is a
 * fixed, generic string built from the kind alone; the original error is kept
 * on `cause` for server-side diagnosis only.
 *
 * Callers branch on `kind` (and `businessCode` for errors raised by the
 * business functions), never on message text.
 */

export type DbErrorKind =
  | "unique_violation" //       23505
  | "foreign_key_violation" //  23503
  | "check_violation" //        23514
  | "not_null_violation" //     23502
  | "invalid_input" //          22xxx (bad uuid / number / parameter value)
  | "serialization_failure" //  40001 - retry the whole transaction
  | "deadlock" //               40P01 - retry the whole transaction
  | "query_timeout" //          57014 - statement_timeout or cancel
  | "business" //               P0001 raised by a function with a code token
  | "unavailable" //            cannot connect, connection lost, server shutting down
  | "unknown";

/**
 * A business error is a `RAISE EXCEPTION '<token>'` from one of the SQL
 * functions (`request_not_found`, `coupon_expired`,
 * `ERR_REFERRAL_CODE_EXHAUSTED`, `orders_append_only`, ...). Only a bare
 * identifier-shaped message counts: a sentence such as
 * 'p_limit must be between 1 and 50' is a programming error, not a business
 * outcome, and stays `unknown` rather than being shown to anyone.
 */
const BUSINESS_TOKEN = /^[A-Za-z][A-Za-z0-9_]{2,62}$/;

const RETRYABLE: ReadonlySet<DbErrorKind> = new Set(["serialization_failure", "deadlock", "unavailable"]);

/** Client-side (node / pg) connection failures, which carry no SQLSTATE. */
const CONNECTION_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

export class DbError extends Error {
  readonly kind: DbErrorKind;
  /** SQLSTATE, when the server produced one. Safe to log. */
  readonly sqlState: string | null;
  /** Constraint name for integrity violations. Safe to log; never shown to users. */
  readonly constraint: string | null;
  /** The raised token for `kind === "business"`, e.g. "request_not_found". */
  readonly businessCode: string | null;
  /** True when retrying (the whole transaction) can succeed. */
  readonly retryable: boolean;

  constructor(
    kind: DbErrorKind,
    details: { sqlState?: string | null; constraint?: string | null; businessCode?: string | null; cause?: unknown } = {},
  ) {
    super(`database error: ${kind}`, { cause: details.cause });
    this.name = "DbError";
    this.kind = kind;
    this.sqlState = details.sqlState ?? null;
    this.constraint = details.constraint ?? null;
    this.businessCode = details.businessCode ?? null;
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Misconfiguration (missing or unsafe connection URL, bad pool setting). Never retryable. */
export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbConfigError";
  }
}

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
}

function kindForSqlState(code: string): DbErrorKind {
  switch (code) {
    case "23505": return "unique_violation";
    case "23503": return "foreign_key_violation";
    case "23514": return "check_violation";
    case "23502": return "not_null_violation";
    case "40001": return "serialization_failure";
    case "40P01": return "deadlock";
    case "57014": return "query_timeout";
    // admin_shutdown, crash_shutdown, cannot_connect_now
    case "57P01": case "57P02": case "57P03": return "unavailable";
  }
  if (code.startsWith("08")) return "unavailable"; // connection exceptions
  if (code.startsWith("22")) return "invalid_input"; // data exceptions
  return "unknown";
}

/**
 * Map anything thrown by node-postgres to a `DbError`. Idempotent: a `DbError`
 * or `DbConfigError` passes through unchanged.
 */
export function normalizePgError(error: unknown): DbError | DbConfigError {
  if (error instanceof DbError || error instanceof DbConfigError) return error;

  const e = (typeof error === "object" && error !== null ? error : {}) as PgLikeError;
  const code = typeof e.code === "string" ? e.code : null;
  const constraint = typeof e.constraint === "string" ? e.constraint : null;

  if (code && CONNECTION_ERRNO.has(code)) {
    return new DbError("unavailable", { cause: error });
  }

  // SQLSTATE: five characters, digits and upper-case letters.
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    if (code === "P0001") {
      const message = typeof e.message === "string" ? e.message : "";
      if (BUSINESS_TOKEN.test(message)) {
        return new DbError("business", { sqlState: code, businessCode: message, cause: error });
      }
      return new DbError("unknown", { sqlState: code, cause: error });
    }
    return new DbError(kindForSqlState(code), { sqlState: code, constraint, cause: error });
  }

  // pg-pool's own failures carry no code: an exhausted connect timeout, or a
  // connection that dropped mid-query.
  const message = typeof e.message === "string" ? e.message : "";
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(message)) {
    return new DbError("unavailable", { cause: error });
  }

  return new DbError("unknown", { cause: error });
}

/** True when `error` is the business error raised as `code` by a SQL function. */
export function isBusinessError(error: unknown, code: string): boolean {
  const normalized = normalizePgError(error);
  return normalized instanceof DbError && normalized.kind === "business" && normalized.businessCode === code;
}

/**
 * The fields of an error that are safe in a server log line: kind, SQLSTATE,
 * constraint and business code. Never the raw message, the row detail or the
 * connection target.
 */
export function describeDbError(error: unknown): Record<string, string | boolean | null> {
  const normalized = normalizePgError(error);
  if (normalized instanceof DbConfigError) return { kind: "config", message: normalized.message };
  return {
    kind: normalized.kind,
    sqlState: normalized.sqlState,
    constraint: normalized.constraint,
    businessCode: normalized.businessCode,
    retryable: normalized.retryable,
  };
}

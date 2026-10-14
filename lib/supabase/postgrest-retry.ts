/**
 * Server-side PostgREST retry policy (V0.1.36): one network attempt per call.
 *
 * `@supabase/postgrest-js` 2.110 retries every GET/HEAD/OPTIONS that throws a
 * fetch error (our `FetchTimeoutError` included) or answers 503/520, three
 * times with 1 s + 2 s + 4 s backoff. On the server that turns one failed read
 * into ~7 s, and one hanging read into 4 x 10 s timeouts + 7 s = ~47 s, so
 * `SUPABASE_REQUEST_TIMEOUT_MS` stops being the upper bound it claims to be.
 *
 * Disabling it uses postgrest-js's own documented `retry` option
 * (`PostgrestClient` constructor / public `retry` field, inherited by every
 * `from()`, `schema()` and `rpc()` builder). supabase-js 2.110 does not forward
 * that option from `createClient`, so it is set on the client's PostgREST
 * instance after construction. Per-query `.retry(false)` would do the same
 * thing but has to be remembered at every call site.
 *
 * POST/PATCH/DELETE/RPC were never retried by the library and are unaffected;
 * no application-level retry is added anywhere. Auth and Storage have their own
 * clients and are out of scope here.
 *
 * Clients without a PostgREST instance (unit-test doubles) are returned as-is.
 * `tests/unit/supabase-postgrest-retry.test.ts` runs the real client, so a
 * library upgrade that moves this field fails there rather than silently
 * bringing the backoff back.
 */
export function disablePostgrestRetries<T>(client: T): T {
  const rest = (client as { rest?: unknown } | null)?.rest
  if (rest && typeof rest === "object") {
    ;(rest as { retry?: boolean }).retry = false
  }
  return client
}

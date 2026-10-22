import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";

const CONSUME = `SELECT public.consume_internal_write_nonce($1, to_timestamp($2), $3) AS consumed`;

/**
 * Consume a v3 write-assertion nonce (V0.1.47) through the EXECUTE-only
 * trusted function from migration 0012. True exactly once per nonce; false
 * for every later or concurrent use. The backend app role has no privilege on
 * the table itself.
 *
 * Only the opaque nonce, the assertion expiry (unix seconds) and the request
 * id are sent: nothing that identifies the user.
 */
export async function consumeWriteNonce(
  db: Queryable,
  input: { nonce: string; expiresAtSeconds: number; requestId: string },
): Promise<boolean> {
  const rows = await runQuery<{ consumed: boolean }>(db, CONSUME, [input.nonce, input.expiresAtSeconds, input.requestId]);
  return rows[0]?.consumed === true;
}

import type { Pool, PoolClient } from "pg";
import { getPool } from "./pool";
import type { Queryable } from "./types";

/**
 * Run `work` inside one transaction on one pooled connection.
 *
 *  - BEGIN, then `work(client)`, then COMMIT.
 *  - Any error from `work` (or from COMMIT) rolls back and is rethrown exactly
 *    as thrown - not wrapped, not normalised - so callers see the original.
 *  - The connection is always returned to the pool. If ROLLBACK itself fails
 *    the connection is in an unknown state, so it is destroyed instead of
 *    reused (`release(err)`), and the ORIGINAL error is still the one thrown.
 *
 * `work` receives a `Queryable`, not the raw client: it can run SQL, but it
 * cannot release the connection or reach the pool. No nested transactions
 * and no savepoint emulation - a repository that needs atomicity takes the
 * `Queryable` it is given and lets the caller own the transaction.
 */
export async function withTransaction<T>(
  work: (tx: Queryable) => Promise<T>,
  pool: Pick<Pool, "connect"> = getPool(),
): Promise<T> {
  const client: PoolClient = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      released = true;
      client.release(rollbackError instanceof Error ? rollbackError : true);
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

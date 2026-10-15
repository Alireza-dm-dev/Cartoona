import type { QueryResultRow } from "pg";
import { normalizePgError } from "./errors";
import type { Queryable } from "./types";

/**
 * Run one parameterised statement and return its rows, normalising any
 * failure to `DbError`. Repositories call this rather than `db.query` so the
 * no-raw-messages rule lives in one place.
 *
 * `text` must be a constant: values go in `values` and reach PostgreSQL as
 * bind parameters ($1, $2, ...), never spliced into the SQL.
 */
export async function runQuery<R extends QueryResultRow>(
  db: Queryable,
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  try {
    const result = await db.query<R>(text, values);
    return result.rows;
  } catch (error) {
    throw normalizePgError(error);
  }
}

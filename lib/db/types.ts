import type { QueryResult, QueryResultRow } from "pg";

/**
 * Anything a repository can run SQL on: the process pool, or the client a
 * transaction hands out. Repositories take one of these as their first
 * argument and never reach for the pool themselves, so the same function runs
 * standalone or inside `withTransaction` without change.
 *
 * Deliberately just `query(text, values)`: SQL text is a constant and every
 * value travels as a bind parameter. No query builder, no ORM.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Explicit actor identity for repositories.
 *
 * The plain-PostgreSQL schema has no auth.uid(), no JWT claims and no RLS: a
 * query sees exactly the rows its WHERE clause selects. So every
 * ownership-sensitive repository function takes the caller's already-resolved
 * id (`userId`, `parentProfileId`) as an argument and puts it in the
 * predicate. Resolving WHO is calling is the auth adapter's job, upstream.
 *
 * Ids are validated before any SQL runs. An id that is not a UUID is a
 * programming error (actor ids come from the server, never from a request
 * body), so it throws instead of quietly matching nothing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RepositoryInputError extends Error {
  constructor(field: string) {
    super(field + " must be a UUID");
    this.name = "RepositoryInputError";
  }
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new RepositoryInputError(field);
  return value;
}

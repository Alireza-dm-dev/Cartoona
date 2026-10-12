/**
 * Pagination primitives for the private gallery. Pure and dependency-free so
 * the server query and the client "load more" code share one definition.
 *
 * Keyset (cursor) pagination over (created_at DESC, id DESC): stable while new
 * uploads arrive, so "load more" never repeats or skips an item the way an
 * offset would.
 */

/** 2 columns on mobile and 3 on desktop both divide 24 evenly. */
export const GALLERY_DEFAULT_PAGE_SIZE = 24;
/** Hard ceiling: a client can never ask for an unbounded page. */
export const GALLERY_MAX_PAGE_SIZE = 48;

export function clampGalleryPageSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return GALLERY_DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), GALLERY_MAX_PAGE_SIZE);
}

export interface GalleryCursor {
  /** Raw `created_at` string exactly as the database returned it. */
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 timestamptz as PostgREST renders it. Deliberately strict: the value
// is placed into a filter expression, so it must not carry `,` `(` `)` etc.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export function encodeGalleryCursor(cursor: GalleryCursor): string {
  return toBase64Url(`${cursor.createdAt}|${cursor.id}`);
}

/** Returns null for anything that is not a well-formed cursor we issued. */
export function decodeGalleryCursor(raw: unknown): GalleryCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let decoded: string;
  try {
    decoded = fromBase64Url(raw);
  } catch {
    return null;
  }
  const sep = decoded.lastIndexOf("|");
  if (sep === -1) return null;
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!TIMESTAMP.test(createdAt) || !UUID.test(id)) return null;
  if (Number.isNaN(Date.parse(createdAt.replace(" ", "T")))) return null;
  return { createdAt, id };
}

/** Append a page, ignoring any item already present (no duplicates). */
export function appendUniqueById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((m) => m.id));
  const out = existing.slice();
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

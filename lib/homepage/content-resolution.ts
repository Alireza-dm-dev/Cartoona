import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";
import { validateHomepageContent } from "@/lib/homepage/validation";
import type { HomepageContent } from "@/lib/homepage/types";

/** Where the resolved content came from. Surfaced for admin diagnostics and tests. */
export type HomepageContentSource =
  | "database"
  | "default-missing-row"
  | "default-invalid-content"
  | "default-read-error";

export interface HomepageContentResult {
  content: HomepageContent;
  source: HomepageContentSource;
  revision: number | null;
}

/** The subset of the row this decision needs. */
export interface HomepageContentRow {
  content_json: unknown;
  revision: unknown;
}

/** Controlled normalizer: fills newly-added optional/versioned presentation fields
 * from defaults for backward compatibility. Only fields explicitly introduced by
 * newer CMS versions receive defaults; structural corruption is NOT silently repaired.
 *
 * Pure: the input object is never mutated. Callers pass raw database JSON and
 * `DEFAULT_HOMEPAGE_CONTENT` through here, and neither may be written to -
 * `DEFAULT_HOMEPAGE_CONTENT` is a shared module singleton, and a mutated row
 * would make the function non-idempotent.
 */
export function normalizeHomepageContent(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const obj = raw as Record<string, unknown>;

  // Navigation: introduced in Phase 4A. Old rows predate it, so supply the
  // default labels rather than failing validation on a field they never had.
  if (!obj.navigation) {
    return {
      ...obj,
      navigation: { ...DEFAULT_HOMEPAGE_CONTENT.navigation },
    };
  }

  // Nothing to backfill. Returned as-is: this function is intentionally narrow
  // and performs no structural repair of existing sections.
  return obj;
}

export interface ResolveInput {
  row: HomepageContentRow | null;
  /** True when the read itself failed, as opposed to simply returning no row. */
  readFailed?: boolean;
}

/** A structured note for the caller to log. Never contains stored values. */
export interface ResolveDiagnostic {
  level: "warn" | "error";
  message: string;
  fields?: string[];
}

export interface ResolveOutcome extends HomepageContentResult {
  diagnostic: ResolveDiagnostic | null;
}

function withDefaults(source: HomepageContentSource): HomepageContentResult {
  return { content: DEFAULT_HOMEPAGE_CONTENT, source, revision: null };
}

/**
 * Decides what the homepage should render given whatever came back from the
 * database. Pure: no IO, no logging, no throwing.
 *
 * The homepage must render regardless of database state, so every failure path
 * resolves to {@link DEFAULT_HOMEPAGE_CONTENT} - a failed read, a missing row on
 * a fresh environment, or stored content that no longer satisfies the contract.
 * Diagnostics carry field paths only, never stored values.
 */
export function resolveHomepageContent({ row, readFailed = false }: ResolveInput): ResolveOutcome {
  if (readFailed) {
    return {
      ...withDefaults("default-read-error"),
      diagnostic: { level: "error", message: "Homepage content read failed; serving defaults" },
    };
  }

  if (!row) {
    return {
      ...withDefaults("default-missing-row"),
      diagnostic: { level: "warn", message: "No homepage content row; serving defaults" },
    };
  }

  // Normalize first: fill newly-added optional fields from defaults
  // so old rows without navigation etc. still validate successfully.
  const normalized = normalizeHomepageContent(row.content_json);

  const result = validateHomepageContent(normalized);
  if (!result.ok) {
    return {
      ...withDefaults("default-invalid-content"),
      diagnostic: {
        level: "error",
        message: "Stored homepage content failed validation; serving defaults",
        fields: result.errors.slice(0, 20).map((e) => e.field),
      },
    };
  }

  return {
    content: result.content,
    source: "database",
    revision: typeof row.revision === "number" ? row.revision : null,
    diagnostic: null,
  };
}

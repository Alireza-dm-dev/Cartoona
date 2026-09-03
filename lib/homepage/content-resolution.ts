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

  const result = validateHomepageContent(row.content_json);
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

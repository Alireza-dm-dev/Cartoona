import type { HomepageContent } from "@/lib/homepage/types";
import type { HomepageValidationError } from "@/lib/homepage/validation";

/**
 * Admin homepage editor API contract (Phase 2).
 *
 * GET /api/admin/homepage  → AdminHomepageGetResponse
 * PUT /api/admin/homepage  → { content, revision } | error
 *
 * The editor never invents structure: PUT accepts a full HomepageContent
 * document plus the revision it was loaded at. The server re-validates every
 * field and enforces optimistic concurrency — a stale revision returns 409
 * with the current server snapshot so the editor can reload-on-conflict.
 *
 * Deliberately NOT modelled here (code-controlled, Phase 3+):
 * HERO_ZOOM, HERO_TV_FOCUS, TV_SCREEN_RECT, background crops, horizontal
 * story mechanics, breakpoints, section order, motion architecture.
 */

export type AdminHomepageSource = "database" | "default";

export interface AdminHomepageGetResponse {
  content: HomepageContent;
  /** Revision of the stored row, or null when serving bundled defaults. */
  revision: number | null;
  /** True when the CMS row is missing/invalid — the editor starts from defaults. */
  isDefault: boolean;
  source: AdminHomepageSource;
}

export interface AdminHomepagePutRequest {
  content: unknown;
  /** The revision the editor loaded. Must match the row or the write is rejected. */
  expectedRevision: unknown;
}

export interface AdminHomepagePutSuccess {
  content: HomepageContent;
  revision: number;
  updatedAt: string;
}

export interface AdminHomepageConflict {
  error: string;
  code: "HOMEPAGE_CONFLICT";
  /** Current server snapshot so the editor can offer reload-on-conflict. */
  content: HomepageContent;
  revision: number;
}

export interface AdminHomepageValidationFailure {
  error: string;
  code: "HOMEPAGE_INVALID";
  errors: HomepageValidationError[];
}

export type AdminHomepageApiErrorCode =
  | "HOMEPAGE_CONFLICT"
  | "HOMEPAGE_INVALID"
  | "HOMEPAGE_NOT_FOUND"
  | "HOMEPAGE_FORBIDDEN"
  | "HOMEPAGE_UNKNOWN_ERROR";

export interface AdminHomepageErrorResponse {
  error: string;
  code: AdminHomepageApiErrorCode;
  errors?: HomepageValidationError[];
}

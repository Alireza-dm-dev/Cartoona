import type { BackendParentRejection } from "../backend-caller";

/**
 * Strict validators for the backend's parent account answers (V0.1.46). Pure.
 * The loader passes them to the backend client as `parse`; anything they
 * throw on becomes `invalid_response` (a safe 503), so a malformed or widened
 * backend body never reaches the browser. Each 200 body is rebuilt with only
 * its documented field, so an extra column the backend might add is dropped.
 */

export type BackendAccountOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "rejected"; error: BackendParentRejection };

const ERRORS: Record<number, readonly BackendParentRejection[]> = {
  401: ["unauthenticated", "session_expired", "session_invalidated"],
  403: ["identity_not_linked", "forbidden"],
  404: ["parent_profile_not_found"],
};

/** Accepted non-2xx statuses: the auth and no-profile answers above. */
export const ACCOUNT_ACCEPT_STATUSES = [401, 403, 404] as const;

/** Far beyond any real count or balance; a larger number means a broken backend. */
const MAX_COUNT = 1_000_000_000;
const MAX_NAME = 500;

function rejection(json: unknown, status: number): BackendAccountOutcome<never> {
  const body = (json ?? {}) as Record<string, unknown>;
  const allowed = ERRORS[status];
  if (typeof body.error === "string" && allowed?.includes(body.error as BackendParentRejection)) {
    return { kind: "rejected", error: body.error as BackendParentRejection };
  }
  throw new Error("unexpected backend body");
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) throw new Error(field);
  return value;
}

function field(json: unknown): Record<string, unknown> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body");
  return json as Record<string, unknown>;
}

export function parseBackendProfile(json: unknown, status: number): BackendAccountOutcome<{ fullName: string | null }> {
  if (status !== 200) return rejection(json, status);
  const name = field(json).fullName;
  if (name !== null && (typeof name !== "string" || name.length > MAX_NAME)) throw new Error("fullName");
  return { kind: "value", value: { fullName: name } };
}

export function parseBackendCandyBalance(json: unknown, status: number): BackendAccountOutcome<number> {
  if (status !== 200) return rejection(json, status);
  return { kind: "value", value: count(field(json).balance, "balance") };
}

export function parseBackendWelcomeCredits(json: unknown, status: number): BackendAccountOutcome<number> {
  if (status !== 200) return rejection(json, status);
  return { kind: "value", value: count(field(json).welcomeImageCreditsRemaining, "welcomeImageCreditsRemaining") };
}

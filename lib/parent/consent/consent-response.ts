import type { BackendParentRejection } from "../backend-caller";

/**
 * Strict validators for the backend's consent answers (V0.1.48). Pure.
 * Anything they throw on becomes `invalid_response` in the backend client (a
 * safe 503, and for the write an uncertain outcome), so a malformed or widened
 * backend body never decides a consent gate. Each body is rebuilt with only
 * its two documented fields.
 */

export interface ConsentState {
  consentGranted: boolean;
  /** ISO timestamp of the first grant; null while not granted (or a legacy row without one). */
  consentGrantedAt: string | null;
}

export type BackendConsentOutcome =
  | { kind: "value"; value: ConsentState }
  | { kind: "rejected"; error: BackendParentRejection | "replayed_request" };

const ERRORS: Record<number, readonly (BackendParentRejection | "replayed_request")[]> = {
  401: ["unauthenticated", "session_expired", "session_invalidated"],
  403: ["identity_not_linked", "forbidden"],
  404: ["parent_profile_not_found"],
  409: ["replayed_request"],
};

export const CONSENT_READ_ACCEPT_STATUSES = [401, 403, 404] as const;
/** The write also accepts 409 (its nonce was already consumed: see backend-consent.ts). */
export const CONSENT_WRITE_ACCEPT_STATUSES = [401, 403, 404, 409] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function parseBackendConsent(json: unknown, status: number): BackendConsentOutcome {
  if (status !== 200) {
    const body = (json ?? {}) as Record<string, unknown>;
    const allowed = ERRORS[status];
    if (typeof body.error === "string" && allowed?.includes(body.error as BackendParentRejection)) {
      return { kind: "rejected", error: body.error as BackendParentRejection | "replayed_request" };
    }
    throw new Error("unexpected backend body");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("body");
  const { consentGranted, consentGrantedAt } = json as Record<string, unknown>;
  if (typeof consentGranted !== "boolean") throw new Error("consentGranted");
  if (consentGrantedAt !== null && (typeof consentGrantedAt !== "string" || !ISO.test(consentGrantedAt))) {
    throw new Error("consentGrantedAt");
  }
  return { kind: "value", value: { consentGranted, consentGrantedAt } };
}

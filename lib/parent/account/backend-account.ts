import "server-only";

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { backendGetJson } from "@/lib/backend/client";
import { isBackendClientError } from "@/lib/backend/errors";
import { currentRequestId } from "@/lib/observability/request-context";
import { mapBackendRejection, verifyParentCaller, type ParentBackendFailure } from "../backend-caller";
import {
  ACCOUNT_ACCEPT_STATUSES,
  parseBackendCandyBalance,
  parseBackendProfile,
  parseBackendWelcomeCredits,
  type BackendAccountOutcome,
} from "./account-response";

/**
 * The parent ACCOUNT reads through the backend (V0.1.46): profile name, candy
 * balance and welcome image credits.
 *
 *   Supabase session cookie
 *     -> verifyParentCaller()   provider verifies the token (once per request)
 *     -> backendGetJson()       one signed v2 assertion per read, bound to its path; one attempt, bounded
 *     -> Fastify requireAuth + requireRole("parent") -> parent profile -> PostgreSQL
 *
 * No Supabase table, RPC or PostgreSQL access happens here; Supabase is only
 * the identity provider. The caller never names an identity: the backend
 * derives the parent from the assertion.
 *
 * Results are a closed set of reasons; the routes map them to HTTP and the
 * header to "anonymous".
 */

export type ParentAccountFailure =
  | "unauthenticated" //       no session, or the provider rejected it
  | "auth_unavailable" //      identity provider down or too slow (never a sign-out)
  | ParentBackendFailure; //   session_expired, session_invalidated, identity_not_linked,
//                             forbidden, no_parent_profile, service_unavailable

export type AccountRead<T> = { ok: true; value: T } | { ok: false; reason: ParentAccountFailure };

async function read<T>(
  context: VerifiedAuthContext,
  operation: string,
  path: string,
  parse: (json: unknown, status: number) => BackendAccountOutcome<T>,
): Promise<AccountRead<T>> {
  let outcome: BackendAccountOutcome<T>;
  try {
    ({ data: outcome } = await backendGetJson({
      operation,
      path,
      requestId: currentRequestId(),
      auth: context,
      acceptStatuses: ACCOUNT_ACCEPT_STATUSES,
      parse,
    }));
  } catch (error) {
    // Timeout, refused connection, 5xx (incl. the backend's database 503),
    // not configured, or a body that failed validation: one safe outcome.
    if (isBackendClientError(error)) return { ok: false, reason: "service_unavailable" };
    throw error;
  }
  if (outcome.kind === "value") return { ok: true, value: outcome.value };
  return { ok: false, reason: mapBackendRejection(outcome.error) };
}

export function fetchParentProfile(context: VerifiedAuthContext): Promise<AccountRead<{ fullName: string | null }>> {
  return read(context, "parent_profile", "/v1/parent/profile", parseBackendProfile);
}

export function fetchParentCandyBalance(context: VerifiedAuthContext): Promise<AccountRead<number>> {
  return read(context, "parent_candy_balance", "/v1/parent/candy-balance", parseBackendCandyBalance);
}

export function fetchParentWelcomeCredits(context: VerifiedAuthContext): Promise<AccountRead<number>> {
  return read(context, "parent_welcome_credits", "/v1/parent/welcome-credits", parseBackendWelcomeCredits);
}

/** GET /api/parent/welcome-credits: verify, then one read. */
export async function loadParentWelcomeCredits(): Promise<AccountRead<number>> {
  const caller = await verifyParentCaller();
  if (!caller.ok) return caller;
  return fetchParentWelcomeCredits(caller.context);
}

export interface ParentAccountSummary {
  balance: number;
  /** null: could not be read. Never shown as a number (see welcome-credits-note). */
  welcomeImageCreditsRemaining: number | null;
}

/**
 * GET /api/parent/account-summary (the billing page): ONE session
 * verification, then the balance and the credits in PARALLEL, each with its
 * own assertion. The balance decides the outcome; a failed credits read only
 * hides the credits note, exactly as before the cutover.
 */
export async function loadParentAccountSummary(): Promise<AccountRead<ParentAccountSummary>> {
  const caller = await verifyParentCaller();
  if (!caller.ok) return caller;
  const [balance, credits] = await Promise.all([
    fetchParentCandyBalance(caller.context),
    fetchParentWelcomeCredits(caller.context),
  ]);
  if (!balance.ok) return balance;
  return { ok: true, value: { balance: balance.value, welcomeImageCreditsRemaining: credits.ok ? credits.value : null } };
}

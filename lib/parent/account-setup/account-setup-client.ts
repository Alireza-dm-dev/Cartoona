import { ACCOUNT_SETUP_INCOMPLETE } from "./messages";

/**
 * Browser side of the post-sign-in bootstrap (V0.1.49): POST
 * /api/parent/account-setup, which makes sure the parent's account exists in
 * Cartoona's PostgreSQL. The browser never calls the backend and sends no
 * identity: the body is always `{}`.
 *
 *   ready       the account is complete; continue
 *   retry       signed in, but the account could not be prepared (or
 *               confirmed) right now: show `message` and a retry button.
 *               Never a sign-out, never "continue anyway".
 *   signed_out  the session is gone/expired: back to /login
 *   blocked     refused for good (not a parent, deleted, identity conflict):
 *               show `message`; retrying will not help
 *
 * One request, no automatic retry, never cached.
 */
export type AccountSetupResult =
  | { status: "ready" }
  | { status: "retry" | "signed_out" | "blocked"; message: string };

export async function ensureParentAccountSetup(fetchImpl: typeof fetch = fetch): Promise<AccountSetupResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/parent/account-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { status: "retry", message: ACCOUNT_SETUP_INCOMPLETE };
  }
  if (response.ok) return { status: "ready" };
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  const message = typeof body.error === "string" && body.error ? body.error : ACCOUNT_SETUP_INCOMPLETE;
  if (response.status === 401) return { status: "signed_out", message };
  if (response.status === 403 || response.status === 409) return { status: "blocked", message };
  return { status: "retry", message: ACCOUNT_SETUP_INCOMPLETE };
}

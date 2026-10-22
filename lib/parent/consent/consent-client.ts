/**
 * Browser-side read of the signed-in parent's consent (V0.1.48), through the
 * Next BFF: GET /api/parent-consent -> backend -> PostgreSQL. The browser never
 * reads consent from Supabase and never calls the backend directly.
 *
 *   true    consent granted
 *   false   not granted (a parent without a profile is "not granted", as before)
 *   null    could not be determined (outage, signed out, network): the caller
 *           must not present this as "not consented"
 *
 * One request, no retry, never cached.
 */
export async function readParentConsent(fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const response = await fetchImpl("/api/parent-consent", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { consentGranted?: unknown };
    return typeof body.consentGranted === "boolean" ? body.consentGranted : null;
  } catch {
    return null;
  }
}

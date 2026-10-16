/**
 * Validation of a creation-price catalog payload, as served by the backend
 * (GET /v1/creation-pricing, built from lib/repositories/creation-pricing.ts).
 *
 * Pure and framework-free. The Next route does not trust the backend's JSON:
 * it rebuilds the catalog from validated entries only, so a malformed or
 * unexpectedly large payload is never passed through to the browser.
 *
 * Same acceptance rules as the route this replaced and the repository: a key
 * must be a non-blank string, a cost a positive integer, and an empty catalog
 * is invalid. The bounds (100 entries, 100-character keys) only reject payloads
 * far outside anything the catalog holds.
 */

export const CREATION_PRICES_MAX_ENTRIES = 100
export const CREATION_PRICES_MAX_KEY_LENGTH = 100

/** Returns a fresh `pricing_key -> candy_cost` map, or throws on any violation. */
export function parseCreationPricesPayload(payload: unknown): Record<string, number> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("creation prices: payload is not an object")
  }
  const prices = (payload as { prices?: unknown }).prices
  if (prices === null || typeof prices !== "object" || Array.isArray(prices)) {
    throw new Error("creation prices: prices is not an object")
  }

  const entries = Object.entries(prices as Record<string, unknown>)
  if (entries.length === 0 || entries.length > CREATION_PRICES_MAX_ENTRIES) {
    throw new Error("creation prices: unexpected entry count")
  }

  const valid: Array<[string, number]> = []
  for (const [key, cost] of entries) {
    if (key.trim() === "" || key.length > CREATION_PRICES_MAX_KEY_LENGTH) {
      throw new Error("creation prices: invalid key")
    }
    if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost <= 0) {
      throw new Error("creation prices: invalid cost")
    }
    valid.push([key, cost])
  }
  // fromEntries defines own properties, so a "__proto__" key cannot reach the prototype.
  return Object.fromEntries(valid)
}

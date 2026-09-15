/**
 * Post-login redirect resolution for parent pages.
 *
 * Extracted from the login page so the open-redirect rules are covered by unit
 * tests rather than only exercised through a browser.
 */

const ALLOWED_PARENT_PATHS = new Set([
  "/dashboard",
  "/parent-consent",
  "/complete-request",
])

/**
 * Returns `value` only when it is a safe, same-origin parent path.
 *
 * Anything absolute, scheme-bearing, protocol-relative, traversing, or outside
 * the parent area is dropped rather than sanitized, so a crafted `?from=` can
 * never send a freshly authenticated parent off-site.
 */
export function getSafeParentDestination(value: string | null): string | null {
  if (!value) return null
  if (value.length > 200) return null
  if (value.includes("\\")) return null
  if (value.includes("..")) return null
  if (value.includes("%00")) return null
  if (value.includes("\0")) return null
  if (value.startsWith("//")) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  if (!value.startsWith("/")) return null

  const path = value.split("?")[0].split("#")[0]

  if (ALLOWED_PARENT_PATHS.has(path)) return path
  if (path.startsWith("/dashboard/")) return path

  return null
}

/**
 * Honours a safe `from=` target, except that a parent who has not granted
 * consent is always routed to the consent page first.
 */
export function resolveSuccessfulLoginDestination(
  safeFrom: string | null,
  consentGranted: boolean,
): string {
  if (safeFrom) {
    if (safeFrom === "/parent-consent") return safeFrom
    if (!consentGranted && (safeFrom === "/dashboard" || safeFrom.startsWith("/dashboard/"))) {
      return "/parent-consent"
    }
    return safeFrom
  }
  return consentGranted ? "/dashboard" : "/parent-consent"
}

import "server-only"

import { redirect } from "next/navigation"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { isAdminPrincipal, resolveCallerRole, type RoleResolution } from "@/lib/auth/backend-role"

/**
 * Authoritative server-side page gates (V0.1.53). The Edge middleware only
 * checks that a session exists; THESE decide who may see a privileged page, from
 * the role PostgreSQL holds (via the backend), before any privileged markup or
 * data is produced. `redirect()` throws, so nothing below a failed gate renders.
 *
 *   admin pages        admin | super_admin only
 *   parent pages       parent; an admin is allowed on /dashboard (as before) but sent
 *                      to /admin from the parent-only steps (complete-request, parent-consent)
 *
 * A backend/provider outage is NOT a denial and NOT access: the gate returns
 * `{ ok: false, unavailable: true }` and the page renders its retry message.
 */

export type GateResult =
  | { ok: true; resolution: Extract<RoleResolution, { ok: true }> | null }
  | { ok: false; unavailable: true }

async function ended(): Promise<void> {
  await endParentSession()
}

export async function gateAdminPage(from = "/admin"): Promise<GateResult> {
  const r = await resolveCallerRole()
  if (r.ok) {
    if (!isAdminPrincipal(r.role)) redirect("/dashboard")
    return { ok: true, resolution: r }
  }
  switch (r.reason) {
    case "unauthenticated":
      redirect(`/admin-login?from=${encodeURIComponent(from)}`)
    case "session_expired":
      await ended()
      redirect(`/admin-login?reason=session_expired&from=${encodeURIComponent(from)}`)
    case "identity_not_linked":
    case "forbidden":
      redirect("/dashboard")
    case "unavailable":
      return { ok: false, unavailable: true }
  }
}

export async function gateParentPage(
  from: string,
  opts: { adminTo?: string; /** the consent page IS where an unlinked identity is sent: let it through (resolution null) */ allowUnlinked?: boolean } = {},
): Promise<GateResult> {
  const r = await resolveCallerRole()
  if (r.ok) {
    if (isAdminPrincipal(r.role)) {
      if (opts.adminTo) redirect(opts.adminTo)
      return { ok: true, resolution: r }
    }
    if (r.role !== "parent") redirect(`/login?from=${encodeURIComponent(from)}`)
    return { ok: true, resolution: r }
  }
  switch (r.reason) {
    case "unauthenticated":
    case "forbidden":
      redirect(`/login?from=${encodeURIComponent(from)}`)
    case "session_expired":
      await ended()
      redirect(`/login?reason=session_expired&from=${encodeURIComponent(from)}`)
    case "identity_not_linked":
      // Signed in at the provider but the Cartoona account is not set up yet: the consent page runs the bootstrap.
      if (opts.allowUnlinked) return { ok: true, resolution: null }
      redirect("/parent-consent")
    case "unavailable":
      return { ok: false, unavailable: true }
  }
}

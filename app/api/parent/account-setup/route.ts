import { NextResponse } from "next/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { provisionParentAccount } from "@/lib/parent/account-setup/backend-provision"
import { ACCOUNT_SETUP_INCOMPLETE } from "@/lib/parent/account-setup/messages"
import { withObservability } from "@/lib/observability/request-context"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"

/**
 * POST /api/parent/account-setup (V0.1.49) - the ONE post-sign-in bootstrap:
 * make sure the signed-in parent's account exists in Cartoona's PostgreSQL
 * before the browser enters any migrated parent page. Called by /signup after
 * the code is verified, by /login after every successful sign-in, and by the
 * "try again" button on /parent-consent. Idempotent: an existing account is a
 * no-op, so calling it on every sign-in is safe.
 *
 *   browser -> rejectUnsafeBrowserWrite (JSON, Origin, Sec-Fetch-Site)
 *   -> Supabase Auth verification (amr sign-in time, 30 days)
 *   -> v3 assertion (body digest + nonce) -> Fastify POST /v1/auth/provision
 *   -> provision_supabase_parent_identity() in PostgreSQL
 *
 *   body exactly {}   - no user id, role, profile id or name is accepted
 *   200 { ready: true }
 *   400 malformed JSON / 413 body over 64 bytes / 422 any field
 *   401 code unauthenticated | PARENT_SESSION_EXPIRED (local sign-out)
 *   403 code csrf_rejected | forbidden
 *   409 code account_setup_conflict     the identity is bound elsewhere: support
 *   415 code unsupported_media_type
 *   503 code account_setup_incomplete   the parent IS signed in; the account
 *                                        could not be prepared (or confirmed)
 *                                        now. Retry is safe. Never a sign-out.
 *   503 code SESSION_CHECK_UNAVAILABLE  provider unreachable
 *
 * Supabase Auth stays the identity provider: nothing here signs anyone in or
 * out except the existing expired-session sign-out.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const
const RETRY = { ...NO_STORE, "Retry-After": "2" } as const
const MAX_BODY_BYTES = 64

const LOGIN = "لطفاً ابتدا وارد حساب خود شوید."
const SIGN_IN_AGAIN = "برای ادامه دوباره وارد حساب شوید."
const NOT_ALLOWED = "شما مجوز انجام این عملیات را ندارید."
const CONFLICT = "حساب شما نیاز به بررسی پشتیبانی دارد. لطفاً با پشتیبانی تماس بگیرید."

const json = (body: unknown, status: number, headers: Record<string, string> = NO_STORE) =>
  NextResponse.json(body, { status, headers })

async function handlePost(request: Request) {
  const rejected = rejectUnsafeBrowserWrite(request)
  if (rejected) return rejected

  const caller = await verifyParentCaller()
  if (!caller.ok) {
    switch (caller.reason) {
      case "unauthenticated":
        return json({ error: LOGIN, code: "unauthenticated" }, 401)
      case "session_expired":
        await endParentSession()
        return json({ error: SIGN_IN_AGAIN, code: "PARENT_SESSION_EXPIRED" }, 401)
      case "auth_unavailable":
        return json(SESSION_CHECK_UNAVAILABLE_BODY, 503, RETRY)
    }
  }

  const declared = request.headers.get("content-length")
  if (declared !== null && !(/^\d+$/.test(declared.trim()) && Number(declared) <= MAX_BODY_BYTES)) {
    return json({ error: "Request body too large" }, 413)
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request body too large" }, 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "Malformed request body" }, 400)
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Malformed request body" }, 400)
  }
  if (Object.keys(body).length > 0) return json({ error: "Unsupported fields" }, 422)

  const result = await provisionParentAccount(caller.context)
  if (result.ok) return json({ ready: true }, 200)
  switch (result.reason) {
    case "session_expired":
    case "session_invalidated":
      await endParentSession()
      return json({ error: SIGN_IN_AGAIN, code: "PARENT_SESSION_EXPIRED" }, 401)
    case "forbidden":
      return json({ error: NOT_ALLOWED, code: "forbidden" }, 403)
    case "identity_conflict":
      return json({ error: CONFLICT, code: "account_setup_conflict" }, 409)
    case "service_unavailable":
    case "outcome_unknown":
      return json({ error: ACCOUNT_SETUP_INCOMPLETE, code: "account_setup_incomplete" }, 503, RETRY)
  }
}

export const POST = withObservability("POST /api/parent/account-setup", handlePost)

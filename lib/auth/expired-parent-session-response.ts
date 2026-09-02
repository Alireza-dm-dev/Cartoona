import { NextResponse } from "next/server"

const EXPIRED_SESSION_BODY = {
  error: "برای ادامه دوباره وارد حساب شوید.",
  code: "PARENT_SESSION_EXPIRED",
}

async function localSignOut(
  supabase: { auth: { signOut: (opts: { scope: "local" }) => Promise<unknown> } },
): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: "local" })
  } catch {
    // Fail closed — return expired response even if sign-out fails
  }
}

export async function createExpiredParentSessionResponse(
  supabase: { auth: { signOut: (opts: { scope: "local" }) => Promise<unknown> } },
): Promise<NextResponse> {
  await localSignOut(supabase)
  return NextResponse.json(EXPIRED_SESSION_BODY, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

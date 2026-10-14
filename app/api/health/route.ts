import { NextResponse } from "next/server"

/**
 * Liveness probe for the web process — nothing else (V0.1.35).
 *
 * Deliberately provider-neutral and dependency-free: it imports no Supabase
 * client, touches no database, reads no environment variable and performs no
 * network call. A 200 here means exactly one thing — this Node process is up
 * and serving HTTP. That is what Docker's healthcheck needs to know; mixing in
 * backend reachability would restart a perfectly healthy container whenever an
 * external service blipped, and would make the answer depend on whichever
 * backend provider is chosen later.
 *
 * The response body is a fixed literal. It never reports env values, versions,
 * project refs, build ids or dependency status, so the endpoint stays safe to
 * leave unauthenticated.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export function GET() {
  return NextResponse.json(
    { status: "ok" },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

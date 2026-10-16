import { NextResponse } from "next/server"
import { backendGetJson } from "@/lib/backend/client"
import { isBackendClientError } from "@/lib/backend/errors"
import { parseCreationPricesPayload } from "@/lib/pricing/creation-prices"
import { currentRequestId, withObservability } from "@/lib/observability/request-context"

/**
 * GET /api/creation-pricing - the first route served through the backend
 * (V0.1.41):
 *
 *   Browser -> this route -> Fastify GET /v1/creation-pricing -> PostgreSQL
 *
 * The browser still calls only this path, and the response is the contract it
 * always had. This route owns that contract: the Cache-Control values, the
 * Persian message and the error code live HERE, not in whatever the backend
 * sends.
 *
 * There is deliberately NO fallback. If the backend is unreachable, slow
 * (BACKEND_REQUEST_TIMEOUT_MS, one attempt), answers non-2xx, or returns a
 * payload that fails validation, the answer is the public 503 below. It never
 * reads Supabase or any other source, so a backend outage is visible instead of
 * silently serving data from somewhere else.
 *
 * Must stay dynamic: no request-bound API is used any more (the Supabase client
 * read cookies), and without this Next would pre-render the route at build time
 * and freeze one catalog into the image.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const SUCCESS_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
  "X-Content-Type-Options": "nosniff",
} as const

const FAILURE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const

function unavailable() {
  return NextResponse.json(
    { error: "قیمت‌ها در حال حاضر در دسترس نیستند.", code: "CREATION_PRICING_UNAVAILABLE" },
    { status: 503, headers: FAILURE_HEADERS },
  )
}

async function handleGet() {
  try {
    const { data } = await backendGetJson({
      operation: "creation_pricing",
      path: "/v1/creation-pricing",
      requestId: currentRequestId(),
      parse: parseCreationPricesPayload,
    })
    return NextResponse.json({ prices: data }, { headers: SUCCESS_HEADERS })
  } catch (error) {
    // Every backend failure is already logged (safe fields only) by the client.
    if (isBackendClientError(error)) return unavailable()
    throw error
  }
}

export const GET = withObservability("GET /api/creation-pricing", handleGet)

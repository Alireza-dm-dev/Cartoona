import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthRetryableFetchError, type UserResponse } from '@supabase/supabase-js'
import { getSupabaseEnv } from './lib/supabase/env'
import { logEvent } from './lib/observability/logger'
import { REQUEST_ID_HEADER, resolveRequestId } from './lib/observability/request-id'
import { categorizeError } from './lib/observability/errors'
import { createAuthDeadlineFetch, withDeadline } from './lib/auth/auth-deadline'

/**
 * Total time the provider part of the session check may take (V0.1.42: 10 s,
 * V0.1.43: 5 s). auth-js retries a failing token refresh with backoff inside a
 * 30 s budget, so with the auth provider down a protected page used to wait
 * ~26-30 s before its 503. Now every Auth call of this request (verification
 * and any refresh) shares one 5 s budget, and nothing is sent after it.
 * Past the deadline the request is a transient auth failure: the same
 * retryable 503, never a sign-out. (No PostgREST read is made here any more.)
 *
 * Why 5 s and not lower: a refresh that completes after we stopped waiting
 * cannot write its rotated cookies into this response. Supabase's
 * refresh-token reuse interval lets the visitor's prompt retry (the 503 asks
 * for one, Retry-After: 2) pick up that same rotation, so a healthy-but-slow
 * provider does not sign anyone out; a much tighter budget would make that
 * race common on slow mobile links.
 */
const MIDDLEWARE_AUTH_DEADLINE_MS = 5_000

function redirectCookies(
  url: string | URL,
  supabaseResponse: NextResponse
): NextResponse {
  const response = NextResponse.redirect(url)
  for (const cookie of supabaseResponse.cookies.getAll()) {
    response.cookies.set(cookie.name, cookie.value, cookie)
  }
  return response
}

/**
 * Retryable answer for a protected request whose auth/session check could not
 * be completed (network or backend failure). Fails closed - no protected
 * content - but, unlike an expiry, never signs out or clears auth cookies, so
 * the user's still-valid session survives and a plain reload works. Any cookie
 * the Supabase client refreshed during this request is carried over.
 */
function sessionCheckUnavailable(supabaseResponse: NextResponse, requestId: string): NextResponse {
  const response = new NextResponse(
    'بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد صفحه را دوباره بارگذاری کنید.',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '2',
        [REQUEST_ID_HEADER]: requestId,
      },
    },
  )
  for (const cookie of supabaseResponse.cookies.getAll()) {
    response.cookies.set(cookie.name, cookie.value, cookie)
  }
  return response
}

export async function middleware(request: NextRequest) {
  const requestId = resolveRequestId(request.headers)
  let supabaseResponse = NextResponse.next({ request })

  let user = null
  // True only when getUser() failed for an infrastructure reason (network /
  // backend), as opposed to a definite "no valid user" answer.
  let authTransientFailure = false
  let supabase: ReturnType<typeof createServerClient> | null = null

  try {
    const env = getSupabaseEnv()
    supabase = createServerClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        global: { fetch: createAuthDeadlineFetch(Date.now() + MIDDLEWARE_AUTH_DEADLINE_MS) },
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value),
            )
            supabaseResponse = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            )
          },
        },
      },
    )

    const {
      data: { user: verifiedUser },
      error: getUserError,
    } = await withDeadline<UserResponse>(supabase.auth.getUser(), MIDDLEWARE_AUTH_DEADLINE_MS)
    user = verifiedUser
    if (!verifiedUser && getUserError && isAuthRetryableFetchError(getUserError)) {
      authTransientFailure = true
      logEvent('warn', 'AUTH_USER_LOOKUP_FAILED', {
        requestId,
        method: request.method,
        operation: 'middleware',
        subsystem: 'auth',
        errorCode: categorizeError(getUserError, 'auth'),
      })
    }
  } catch (error) {
    user = null
    supabase = null
    authTransientFailure = true
    logEvent('warn', 'AUTH_USER_LOOKUP_FAILED', {
      requestId,
      method: request.method,
      operation: 'middleware',
      subsystem: 'auth',
      errorCode: categorizeError(error, 'auth'),
    })
  }

  const { pathname, search } = request.nextUrl
  const isDashboardPath =
    pathname === '/dashboard' || pathname.startsWith('/dashboard/')
  const isAdminPath =
    pathname === '/admin' || pathname.startsWith('/admin/')
  const isCompleteRequestPath = pathname === '/complete-request'
  const isParentConsentPath = pathname === '/parent-consent'

  const isParentProtectedPage =
    isDashboardPath || isCompleteRequestPath || isParentConsentPath

  // V0.1.53: AUTHENTICATION-ONLY routing. This Edge runtime reads no role and no
  // database: a Supabase `users.role` read used to live here. Who may see what
  // is decided by the server pages / routes themselves, from the role
  // PostgreSQL holds (lib/auth/page-gates.ts -> backend GET /v1/auth/me, and the
  // backend's own role checks on every data route), before any privileged
  // markup or data exists. The 30-day session lifetime and sessions_not_before
  // are enforced there too (the backend applies them to every assertion).
  // The Edge cannot do it: no node:crypto, no internal secret.
  if (isAdminPath) {
    if (!user && authTransientFailure) {
      return sessionCheckUnavailable(supabaseResponse, requestId)
    }
    if (!user) {
      const loginUrl = new URL('/admin-login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }
    return supabaseResponse
  }

  if (isParentProtectedPage) {
    if (!user && authTransientFailure) {
      return sessionCheckUnavailable(supabaseResponse, requestId)
    }
    if (!user) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }
    return supabaseResponse
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/dashboard/:path*', '/dashboard', '/admin/:path*', '/admin', '/complete-request', '/parent-consent'],
}

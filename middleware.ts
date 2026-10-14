import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { getSupabaseEnv } from './lib/supabase/env'
import { supabaseTimeoutFetch } from './lib/supabase/timeout-fetch'
import { disablePostgrestRetries } from './lib/supabase/postgrest-retry'
import { isAdminRole } from './lib/auth/admin-role'
import { isParentRole } from './lib/auth/parent-access'
import { checkCurrentParentSessionLifetime } from './lib/auth/parent-session-lifetime'
import { logEvent } from './lib/observability/logger'
import { REQUEST_ID_HEADER, resolveRequestId } from './lib/observability/request-id'
import { categorizeError } from './lib/observability/errors'

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
    supabase = disablePostgrestRetries(createServerClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        global: { fetch: supabaseTimeoutFetch },
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
    ))

    const {
      data: { user: verifiedUser },
      error: getUserError,
    } = await supabase.auth.getUser()
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

  // ── Admin block (unchanged) ─────────────────────────────────────────────
  if (isAdminPath) {
    if (!user && authTransientFailure) {
      return sessionCheckUnavailable(supabaseResponse, requestId)
    }

    if (!user) {
      const loginUrl = new URL('/admin-login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }

    if (!supabase) {
      return redirectCookies(new URL('/dashboard', request.url), supabaseResponse)
    }

    try {
      const { data: roleRow, error } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()

      if (error || !roleRow || !isAdminRole(roleRow.role)) {
        return redirectCookies(new URL('/dashboard', request.url), supabaseResponse)
      }
    } catch {
      return redirectCookies(new URL('/dashboard', request.url), supabaseResponse)
    }
  }

  // ── Parent-protected pages ──────────────────────────────────────────────
  // Covers /dashboard, /dashboard/*, /complete-request, /parent-consent

  async function redirectExpiredParentSession(): Promise<NextResponse> {
    try {
      await supabase!.auth.signOut({ scope: "local" })
    } catch {
      // Fail closed — continue redirecting
    }
    logEvent('info', 'SESSION_EXPIRED', {
      requestId,
      method: request.method,
      operation: 'middleware',
      subsystem: 'auth',
    })
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('reason', 'session_expired')
    loginUrl.searchParams.set('from', pathname)
    return redirectCookies(loginUrl, supabaseResponse)
  }

  if (isParentProtectedPage) {
    // 1. Authentication check
    if (!user && authTransientFailure) {
      return sessionCheckUnavailable(supabaseResponse, requestId)
    }

    if (!user) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }

    if (!supabase) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }

    // 2. Role lookup
    let roleRow: { role: string } | null = null
    try {
      const { data: row, error: roleError } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()

      if (roleError || !row) {
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('from', pathname + search)
        return redirectCookies(loginUrl, supabaseResponse)
      }
      roleRow = row
    } catch {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }

    if (!roleRow) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }

    // 3. Admin / super_admin on parent pages
    if (isAdminRole(roleRow.role)) {
      if (isCompleteRequestPath || isParentConsentPath) {
        return redirectCookies(new URL('/admin', request.url), supabaseResponse)
      }
      // /dashboard allows admin through (existing behaviour)
      return supabaseResponse
    }

    // 4. Non-parent, non-admin → reject
    if (!isParentRole(roleRow.role)) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('from', pathname + search)
      return redirectCookies(loginUrl, supabaseResponse)
    }

    // 5. Parent session lifetime check
    const lifetime = await checkCurrentParentSessionLifetime(supabase)

    if (!lifetime.valid) {
      // A lookup that could not complete is not an expiry: fail closed with a
      // retryable response and keep the session. Only a definite expiry /
      // missing session signs the user out.
      if (lifetime.reason === 'lookup_failed') {
        logEvent('warn', 'SESSION_LOOKUP_FAILED', {
          requestId,
          method: request.method,
          operation: 'middleware',
          subsystem: 'auth',
          errorCode: 'AUTH_UNAVAILABLE',
          reason: lifetime.reason,
        })
        return sessionCheckUnavailable(supabaseResponse, requestId)
      }
      return redirectExpiredParentSession()
    }

    // 6. Consent check (complete-request only)
    if (isCompleteRequestPath) {
      const { data: profileRow, error: profileError } = await supabase
        .from('parent_profiles')
        .select('consent_granted')
        .eq('user_id', user.id)
        .maybeSingle()

      if (profileError) {
        return redirectCookies(new URL('/parent-consent', request.url), supabaseResponse)
      }

      if (!profileRow || !profileRow.consent_granted) {
        return redirectCookies(new URL('/parent-consent', request.url), supabaseResponse)
      }
    }

    // 7. Allow
    return supabaseResponse
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/dashboard/:path*', '/dashboard', '/admin/:path*', '/admin', '/complete-request', '/parent-consent'],
}

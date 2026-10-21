import http from "node:http"
import type { AddressInfo } from "node:net"
import { accessToken } from "./supabase-jwt"

/**
 * A local, in-process stand-in for Supabase Auth (GoTrue) and the two
 * PostgREST tables the header reads - so the REAL @supabase/ssr + auth-js code
 * (including its refresh retry loop) runs without contacting Supabase.
 *
 * Tokens are Supabase-shaped JWTs (tests/helpers/supabase-jwt.ts) carrying
 * `sub`, `session_id` and `amr`. Like the real provider:
 *  - GET /auth/v1/user accepts ONLY access tokens this stub issued (standing in
 *    for signature verification); anything else is 403 bad_jwt.
 *  - POST /auth/v1/token (refresh) issues a NEW access token for the same
 *    session: new iat/exp, the SAME amr (the sign-in time is per session).
 * Each endpoint's behaviour is switchable per test. Every request is recorded.
 */

export type UserMode = "ok" | "unauthorized" | "server_error" | "hang"
export type RefreshMode = "ok" | "invalid_grant" | "server_error" | "hang"

export interface StubAuthOptions {
  /** Auth user id the stub's sessions belong to. */
  userId: string
  userMode?: UserMode
  refreshMode?: RefreshMode
  /** Rows PostgREST returns for `users` and `parent_profiles` (role gate, profile id). */
  role?: string
  fullName?: string
  /**
   * Rows for other PostgREST tables (V0.1.46), e.g. empty `candy_packages` and
   * `candy_purchases`, so a page whose remaining Supabase reads are out of
   * scope can still render around the parts served by the backend.
   */
  tables?: Record<string, unknown[]>
}

interface IssuedSession {
  sub: string
  sessionId: string
  authenticatedAt: number
  /** Overrides amr in every token of this session (e.g. string-only). */
  amr?: unknown
}

export interface StubAuth {
  url: string
  options: Required<StubAuthOptions>
  requests: Array<{ method: string; path: string; authorization: string | null }>
  /** Access tokens issued by refreshes, in order. */
  refreshedTokens: string[]
  /** A session cookie for a new session of `userId` (sign-in time defaults to an hour ago). */
  cookie(opts?: { expired?: boolean; authenticatedAt?: number; amr?: unknown }): { name: string; value: string }
  close(): Promise<void>
}

export function cookieName(url: string): string {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`
}

function encodeSession(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
}

export async function startStubAuth(initial: StubAuthOptions): Promise<StubAuth> {
  const options: Required<StubAuthOptions> = {
    userMode: "ok",
    refreshMode: "ok",
    role: "parent",
    fullName: "Test Parent",
    tables: {},
    ...initial,
  }
  const requests: StubAuth["requests"] = []
  const refreshedTokens: string[] = []
  const hanging = new Set<http.ServerResponse>()
  /** access token -> its session; refresh token -> its session. */
  const accessTokens = new Map<string, IssuedSession>()
  const refreshTokens = new Map<string, IssuedSession>()
  let counter = 0

  const issueAccess = (session: IssuedSession, issuedAt = Date.now()) => {
    const token = accessToken({ sub: session.sub, sessionId: session.sessionId, authenticatedAt: session.authenticatedAt, issuedAt, amr: session.amr })
    accessTokens.set(token, session)
    return token
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]
    requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization ?? null })
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (path === "/auth/v1/user") {
        switch (options.userMode) {
          case "hang": hanging.add(res); return
          case "server_error": return json(res, 503, { code: 503, msg: "upstream unavailable" })
          case "unauthorized": return json(res, 403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" })
          default: {
            const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
            const session = accessTokens.get(token)
            if (!session) return json(res, 403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" })
            return json(res, 200, {
              id: session.sub, aud: "authenticated", role: "authenticated",
              email: "parent@example.com", phone: "989121234567",
              app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
            })
          }
        }
      }

      if (path === "/auth/v1/token") {
        switch (options.refreshMode) {
          case "hang": hanging.add(res); return
          case "server_error": return json(res, 503, { code: 503, msg: "upstream unavailable" })
          case "invalid_grant": return json(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" })
          default: {
            let presented = ""
            try { presented = JSON.parse(raw).refresh_token ?? "" } catch { /* empty */ }
            const session = refreshTokens.get(presented)
            if (!session) return json(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" })
            refreshTokens.delete(presented)
            const token = issueAccess(session)
            refreshedTokens.push(token)
            const nextRefresh = `refresh-${++counter}`
            refreshTokens.set(nextRefresh, session)
            const now = Math.floor(Date.now() / 1000)
            return json(res, 200, {
              access_token: token, token_type: "bearer", expires_in: 3600, expires_at: now + 3600,
              refresh_token: nextRefresh, user: { id: session.sub, aud: "authenticated", role: "authenticated" },
            })
          }
        }
      }

      if (path === "/rest/v1/users") return json(res, 200, [{ role: options.role }])
      if (path === "/rest/v1/parent_profiles") return json(res, 200, [{ full_name: options.fullName }])
      const table = path.startsWith("/rest/v1/") ? options.tables[path.slice("/rest/v1/".length)] : undefined
      if (table) return json(res, 200, table)
      json(res, 404, {})
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    options,
    requests,
    refreshedTokens,
    cookie(opts = {}) {
      const session: IssuedSession = {
        sub: options.userId,
        sessionId: `5e5e5e5e-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
        authenticatedAt: opts.authenticatedAt ?? Date.now() - 3_600_000,
        amr: opts.amr,
      }
      const now = Date.now()
      // An expired cookie holds an access token issued (and expired) an hour ago.
      const issuedAt = opts.expired ? now - 2 * 3_600_000 : now
      const access = issueAccess(session, issuedAt)
      const refresh = `refresh-${++counter}`
      refreshTokens.set(refresh, session)
      return {
        name: cookieName(url),
        value: encodeSession({
          access_token: access,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(issuedAt / 1000) + 3600,
          refresh_token: refresh,
          user: { id: session.sub, aud: "authenticated", role: "authenticated" },
        }),
      }
    },
    async close() {
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A session cookie NOT known to any stub (e.g. for an unreachable provider URL). */
export function sessionCookie(url: string, opts: { expired?: boolean } = {}) {
  const now = Date.now()
  const issuedAt = opts.expired ? now - 2 * 3_600_000 : now
  const access = accessToken({ sub: "00000000-0000-4000-8000-000000000000", authenticatedAt: now - 3_600_000, issuedAt })
  return {
    name: cookieName(url),
    value: encodeSession({
      access_token: access, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(issuedAt / 1000) + 3600,
      refresh_token: "refresh-original", user: { id: "00000000-0000-4000-8000-000000000000", aud: "authenticated", role: "authenticated" },
    }),
  }
}

/** A request cookie jar that records what the client tries to write (refresh / sign-out). */
export function cookieJar(initial: Array<{ name: string; value: string }> = []) {
  const jar = new Map(initial.map((c) => [c.name, c.value]))
  const writes: Array<{ name: string; value: string }> = []
  return {
    writes,
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    setAll: (cookies: Array<{ name: string; value: string }>) => {
      for (const { name, value } of cookies) {
        writes.push({ name, value })
        if (value === "") jar.delete(name)
        else jar.set(name, value)
      }
    },
    /** True if the session cookie was cleared (a sign-out). */
    cleared: (name: string) => writes.some((w) => w.name.startsWith(name) && w.value === ""),
  }
}

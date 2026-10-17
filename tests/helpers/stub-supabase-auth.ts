import http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A local, in-process stand-in for Supabase Auth (GoTrue) and the two
 * PostgREST tables the header reads - so the REAL @supabase/ssr + auth-js code
 * (including its refresh retry loop) runs without contacting Supabase.
 *
 * Each endpoint's behaviour is switchable per test. Every request is recorded.
 */

export type UserMode = "ok" | "unauthorized" | "server_error" | "hang"
export type RefreshMode = "ok" | "invalid_grant" | "server_error" | "hang"

export interface StubAuthOptions {
  /** Auth user id returned for a valid access token. */
  userId: string
  userMode?: UserMode
  refreshMode?: RefreshMode
  /** Rows PostgREST returns for `users` and `parent_profiles` (header lookup). */
  role?: string
  fullName?: string
}

export interface StubAuth {
  url: string
  options: Required<StubAuthOptions>
  requests: Array<{ method: string; path: string; authorization: string | null }>
  close(): Promise<void>
}

export async function startStubAuth(initial: StubAuthOptions): Promise<StubAuth> {
  const options: Required<StubAuthOptions> = {
    userMode: "ok",
    refreshMode: "ok",
    role: "parent",
    fullName: "Test Parent",
    ...initial,
  }
  const requests: StubAuth["requests"] = []
  const hanging = new Set<http.ServerResponse>()

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]
    requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization ?? null })
    req.resume()

    if (path === "/auth/v1/user") {
      switch (options.userMode) {
        case "hang": hanging.add(res); return
        case "server_error": return json(res, 503, { code: 503, msg: "upstream unavailable" })
        case "unauthorized": return json(res, 403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" })
        default:
          if (!req.headers.authorization?.startsWith("Bearer access-")) {
            return json(res, 403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" })
          }
          return json(res, 200, {
            id: options.userId, aud: "authenticated", role: "authenticated",
            email: "parent@example.com", phone: "989121234567",
            app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
          })
      }
    }

    if (path === "/auth/v1/token") {
      switch (options.refreshMode) {
        case "hang": hanging.add(res); return
        case "server_error": return json(res, 503, { code: 503, msg: "upstream unavailable" })
        case "invalid_grant": return json(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" })
        default: {
          const now = Math.floor(Date.now() / 1000)
          return json(res, 200, {
            access_token: "access-refreshed", token_type: "bearer", expires_in: 3600, expires_at: now + 3600,
            refresh_token: "refresh-rotated", user: { id: options.userId, aud: "authenticated", role: "authenticated" },
          })
        }
      }
    }

    if (path === "/rest/v1/users") return json(res, 200, [{ role: options.role }])
    if (path === "/rest/v1/parent_profiles") return json(res, 200, [{ full_name: options.fullName }])
    json(res, 404, {})
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    options,
    requests,
    async close() {
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** The @supabase/ssr session cookie for `url` (storage key sb-<first host label>-auth-token, base64url encoding). */
export function sessionCookie(url: string, opts: { expired?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = opts.expired ? now - 3600 : now + 3600
  const session = {
    access_token: opts.expired ? "access-expired" : "access-valid",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "refresh-original",
    user: { id: "00000000-0000-4000-8000-000000000000", aud: "authenticated", role: "authenticated" },
  }
  const name = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`
  return { name, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` }
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

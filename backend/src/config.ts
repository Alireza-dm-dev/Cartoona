import { readPoolConfig } from "@/lib/db/pool"
import { readInternalAuthSecret } from "@/lib/identity/assertion"

/**
 * Backend runtime configuration (V0.1.40), validated once at startup.
 *
 *  BACKEND_PORT  (4000)     1-65535
 *  BACKEND_HOST  (0.0.0.0)  0.0.0.0 | 127.0.0.1 | :: | ::1. 0.0.0.0 in a
 *                           container, so the published port reaches it;
 *                           `npm run backend:dev` uses 127.0.0.1 on the Mac.
 *  LOG_LEVEL     (info)     read by lib/observability/logger directly.
 *  DATABASE_URL  required   validated by lib/db's own rules (scheme, no query
 *                           string, never hosted Supabase); it must name a
 *                           restricted login role, which /ready verifies.
 *  CARTOONA_INTERNAL_AUTH_SECRET  required (V0.1.42). Hex, >= 32 bytes; verifies
 *                           the Next server's identity assertions. The same
 *                           value is given to the frontend, nothing else is.
 *  DB_POOL_MAX, DB_IDLE_TIMEOUT_MS, DB_CONNECTION_TIMEOUT_MS  see lib/db/pool.
 *
 * Every error message is written here and names the variable, never its
 * value, so a failed start cannot print the database URL or password.
 */

export interface BackendConfig {
  port: number
  host: string
}

export class BackendConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackendConfigError"
  }
}

const HOSTS = new Set(["0.0.0.0", "127.0.0.1", "::", "::1"])

type Env = Record<string, string | undefined>

export function loadBackendConfig(env: Env = process.env): BackendConfig {
  const rawPort = env.BACKEND_PORT?.trim() || "4000"
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new BackendConfigError("BACKEND_PORT must be an integer between 1 and 65535.")
  }

  const host = env.BACKEND_HOST?.trim() || "0.0.0.0"
  if (!HOSTS.has(host)) {
    throw new BackendConfigError("BACKEND_HOST must be one of 0.0.0.0, 127.0.0.1, :: or ::1.")
  }

  // Fail at startup, not at the first request: same checks the pool applies.
  try {
    readPoolConfig(env)
  } catch (error) {
    throw new BackendConfigError(error instanceof Error ? error.message : "DATABASE_URL is invalid.")
  }
  try {
    readInternalAuthSecret(env)
  } catch (error) {
    throw new BackendConfigError(error instanceof Error ? error.message : "CARTOONA_INTERNAL_AUTH_SECRET is invalid.")
  }

  return { port: Number(rawPort), host }
}

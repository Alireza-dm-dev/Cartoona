import Fastify, { type FastifyInstance } from "fastify"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { readInternalAuthSecret } from "@/lib/identity/assertion"
import { registerErrorHandling } from "./errors/error-handler"
import { registerAuth } from "./plugins/auth"
import { registerObservability, requestIdFor } from "./plugins/observability"
import { registerAuthRoutes } from "./routes/auth"
import { registerCreationPricingRoutes } from "./routes/creation-pricing"
import { registerHealthRoutes } from "./routes/health"
import { registerParentOrdersRoutes } from "./routes/parent-orders"

/**
 * The backend HTTP app (V0.1.40), built WITHOUT listening: tests call
 * `buildBackendApp(...)` and use `app.inject()`; only server.ts binds a port.
 *
 * The database is reached through `deps.db()`, called per request. The
 * default is the shared lib/db pool, created lazily on first use, so building
 * the app (or serving /health) opens no connection. Tests inject a fake.
 * No migrations run here, ever.
 *
 * Deliberately absent: CORS (no browser calls the backend directly; the Next
 * app calls it server-to-server), cookies, any browser identity (the only
 * caller identity is the signed internal assertion, see plugins/auth.ts and
 * auth/principal.ts), request bodies (every route is GET; the body limit is
 * minimal), and Fastify's own pino logger (lib/observability/logger is used
 * instead).
 */

export interface BackendDeps {
  db: () => Queryable
  /** Called once when the app closes; ends the shared pool by default. */
  closeDb: () => Promise<void>
  /** Key for internal assertions; read per request (CARTOONA_INTERNAL_AUTH_SECRET by default). */
  authSecret: () => Buffer
  /** Clock for the session policy, epoch ms; injectable for tests. */
  now: () => number
}

export function buildBackendApp(overrides: Partial<BackendDeps> = {}): FastifyInstance {
  const deps: BackendDeps = {
    db: overrides.db ?? getPool,
    closeDb: overrides.closeDb ?? closePool,
    authSecret: overrides.authSecret ?? (() => readInternalAuthSecret()),
    now: overrides.now ?? Date.now,
  }

  const app = Fastify({
    logger: false,
    genReqId: requestIdFor,
    // Fastify would otherwise trust X-Request-Id verbatim; genReqId validates it.
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: 16 * 1024,
    return503OnClosing: true,
  })

  registerObservability(app)
  registerErrorHandling(app)
  registerAuth(app)
  registerHealthRoutes(app, deps)
  registerCreationPricingRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerParentOrdersRoutes(app, deps)

  app.addHook("onClose", async () => {
    await deps.closeDb()
  })

  return app
}

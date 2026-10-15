import Fastify, { type FastifyInstance } from "fastify"
import { closePool, getPool } from "@/lib/db/pool"
import type { Queryable } from "@/lib/db/types"
import { registerErrorHandling } from "./errors/error-handler"
import { registerObservability, requestIdFor } from "./plugins/observability"
import { registerCreationPricingRoutes } from "./routes/creation-pricing"
import { registerHealthRoutes } from "./routes/health"

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
 * app will call it server-to-server), cookies, auth (see auth/principal.ts),
 * request bodies (every route is GET; the body limit is minimal), and
 * Fastify's own pino logger (lib/observability/logger is used instead).
 */

export interface BackendDeps {
  db: () => Queryable
  /** Called once when the app closes; ends the shared pool by default. */
  closeDb: () => Promise<void>
}

export function buildBackendApp(overrides: Partial<BackendDeps> = {}): FastifyInstance {
  const deps: BackendDeps = {
    db: overrides.db ?? getPool,
    closeDb: overrides.closeDb ?? closePool,
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
  registerHealthRoutes(app, deps)
  registerCreationPricingRoutes(app, deps)

  app.addHook("onClose", async () => {
    await deps.closeDb()
  })

  return app
}

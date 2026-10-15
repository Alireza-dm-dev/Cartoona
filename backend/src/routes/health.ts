import type { FastifyInstance } from "fastify"
import { checkSessionRole, pingDatabase } from "@/lib/db/health"
import { logEvent } from "@/lib/observability/logger"
import type { BackendDeps } from "../app"

/**
 * GET /health - liveness. The process is up and serving HTTP; nothing else.
 *   No database, no env, no dependency: a database outage must never make the
 *   orchestrator restart a healthy backend container.
 *
 * GET /ready - readiness. PostgreSQL answers `SELECT 1` AND the session is a
 *   restricted cartoona_app login (not the owner, not a superuser). The role
 *   check passes once per process and is then cached; the ping runs every time.
 *   The body is a fixed status - never an error kind, message or target.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: BackendDeps): void {
  app.get("/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return { status: "ok" }
  })

  let roleVerified = false

  app.get("/ready", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const db = deps.db()

    const ping = await pingDatabase(db)
    if (!ping.ok) {
      logEvent("warn", "READINESS_FAILED", { requestId: request.id, subsystem: "database", reason: ping.kind })
      return reply.code(503).send({ status: "unavailable" })
    }

    if (!roleVerified) {
      const role = await checkSessionRole(db)
      if (!role.ok) {
        logEvent("error", "READINESS_FAILED", { requestId: request.id, subsystem: "database", reason: `db_role_${role.reason}` })
        return reply.code(503).send({ status: "unavailable" })
      }
      roleVerified = true
    }

    return { status: "ready" }
  })
}

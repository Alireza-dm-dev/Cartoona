import { buildBackendApp } from "./app"
import { BackendConfigError, loadBackendConfig } from "./config"
import { logEvent } from "@/lib/observability/logger"

/**
 * Backend entry point: validate config, build the app, listen, shut down
 * gracefully. Runs as PID 1 in the container (`node server.cjs`), so it
 * installs its own SIGTERM/SIGINT handlers - PID 1 gets no default ones.
 *
 * Shutdown: stop accepting connections, let in-flight requests finish, end
 * the database pool (app onClose), exit 0. A hard deadline exits 1 if
 * anything hangs, well inside Docker's 10 s stop grace period.
 */

const SHUTDOWN_DEADLINE_MS = 8_000

async function main(): Promise<void> {
  let config
  try {
    config = loadBackendConfig()
  } catch (error) {
    // The message names the variable only, never its value.
    const message = error instanceof BackendConfigError ? error.message : "invalid configuration"
    console.error(`backend: refusing to start - ${message}`)
    process.exit(1)
  }

  const app = buildBackendApp()

  let closing = false
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    logEvent("info", "BACKEND_STOPPING", { reason: signal })
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  await app.listen({ port: config.port, host: config.host })
  logEvent("info", "BACKEND_LISTENING", { reason: `port_${config.port}` })
}

main().catch(() => {
  logEvent("error", "BACKEND_START_FAILED", { errorCode: "INTERNAL_ERROR" })
  process.exit(1)
})

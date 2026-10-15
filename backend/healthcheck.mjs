/**
 * Backend container healthcheck (V0.1.40). Liveness only: GET /health on the
 * local process, which never touches the database. Runs with the image's own
 * Node, so no curl/wget is needed. Exit 0 = healthy, 1 = unhealthy.
 */
const port = process.env.BACKEND_PORT || "4000"
const url = `http://127.0.0.1:${port}/health`

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
  process.exit(response.ok ? 0 : 1)
} catch {
  process.exit(1)
}

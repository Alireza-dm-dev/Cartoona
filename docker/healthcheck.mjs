/**
 * Container healthcheck (V0.1.35).
 *
 * Runs inside the runtime image with the same Node binary that serves the app,
 * so the image needs no curl/wget and stays small. Checks only that the local
 * web process answers /api/health with 200 — never an external backend.
 *
 * Exit 0 = healthy, exit 1 = unhealthy; Docker reads nothing else.
 */
const port = process.env.PORT || "3000"
const url = `http://127.0.0.1:${port}/api/health`

// Below Docker's own `timeout`, so a hang fails the probe rather than the probe
// outliving it.
const timeout = AbortSignal.timeout(4000)

try {
  const response = await fetch(url, { signal: timeout, cache: "no-store" })
  if (!response.ok) {
    console.error(`healthcheck: ${url} -> ${response.status}`)
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error(`healthcheck: ${url} unreachable (${error instanceof Error ? error.name : "error"})`)
  process.exit(1)
}

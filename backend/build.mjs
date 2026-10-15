/**
 * Backend build (V0.1.40): bundle backend/src/server.ts and everything it
 * imports - lib/db, lib/repositories, lib/observability, fastify, pg - into ONE
 * file, backend/dist/server.cjs. esbuild resolves the `@/` alias from
 * tsconfig.json, so the shared lib code is used as is, not copied.
 *
 * The runtime image then needs node and this file only: no node_modules, no
 * TypeScript, no source tree.
 *
 *   node backend/build.mjs          build once
 *   node backend/build.mjs --dev    rebuild on change and restart the server
 */
import * as esbuild from "esbuild"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outfile = path.join(root, "backend/dist/server.cjs")
const dev = process.argv.includes("--dev")

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: ["backend/src/server.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  tsconfig: "tsconfig.json",
  sourcemap: dev ? "inline" : false,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  // pg loads its optional native binding lazily and only on request; it is
  // never installed. The Cloudflare socket shim is for Workers only.
  external: ["pg-native", "cloudflare:sockets"],
}

if (!dev) {
  await esbuild.build(options)
  console.log(`backend build: ${path.relative(root, outfile)}`)
} else {
  let child = null
  const restart = {
    name: "restart-server",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return
        if (child) child.kill("SIGTERM")
        child = spawn(process.execPath, [outfile], { stdio: "inherit", env: { BACKEND_HOST: "127.0.0.1", ...process.env } })
      })
    },
  }
  const ctx = await esbuild.context({ ...options, plugins: [restart] })
  await ctx.watch()
  console.log("backend dev: watching backend/src and lib (Ctrl-C to stop)")
  const stop = () => {
    if (child) child.kill("SIGTERM")
    void ctx.dispose().then(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

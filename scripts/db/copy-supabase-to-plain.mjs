#!/usr/bin/env node
/**
 * Supabase-shaped PostgreSQL -> plain PostgreSQL data copy (V0.1.44).
 * Local/testing tooling only; see docs/DATA_MIGRATION.md.
 *
 *   CARTOONA_COPY_SOURCE_URL=postgresql://... CARTOONA_COPY_TARGET_URL=postgresql://... \
 *   npm run db:copy -- [--check] [--manifest file.json] [--stop-after-phase NAME]
 *
 * The TypeScript in scripts/db/data-copy/ is bundled in memory by esbuild (a
 * dev dependency, as for backend/build.mjs) into a private temp file and run.
 * Nothing in the application or the backend bundle imports this tool.
 */
import * as esbuild from "esbuild"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartoona-data-copy-"))
const outfile = path.join(dir, "cli.cjs")
try {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["scripts/db/data-copy/cli.ts"],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    logLevel: "warning",
    external: ["pg-native", "cloudflare:sockets"],
  })
  const { main } = createRequire(import.meta.url)(outfile)
  process.exitCode = await main(process.argv.slice(2), process.env, root)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

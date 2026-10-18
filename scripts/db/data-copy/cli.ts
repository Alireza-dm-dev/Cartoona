import fs from "node:fs"
import path from "node:path"
import { runDataCopy } from "./copy"
import { PHASES } from "./mapping"
import { DataCopyError, redact, urlPassword, validateTargets } from "./safety"

/**
 * CLI for the data copy (V0.1.44). Run through scripts/db/copy-supabase-to-plain.mjs:
 *
 *   CARTOONA_COPY_SOURCE_URL=postgresql://owner:pw@localhost:5433/supabase_staging \
 *   CARTOONA_COPY_TARGET_URL=postgresql://owner:pw@localhost:5433/cartoona_copy \
 *   npm run db:copy -- [--check] [--manifest file.json] [--stop-after-phase NAME] [--batch-size N]
 *
 * URLs come from the environment only (never argv, which other users can see
 * in `ps`). DATABASE_URL and .env files are never read.
 *
 * Exit codes: 0 done / verified no-op / stopped as asked; 2 refused (unsafe or
 * incompatible input, nothing written); 3 unsupported target state (nothing
 * written); 4 integrity, reconciliation, identity or validation failure; 1 unexpected.
 */

function parseArgs(argv: string[]) {
  const out: { check: boolean; manifest?: string; stopAfterPhase?: string; batchSize?: number; sourceMode?: string } = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new DataCopyError("usage", `${a} needs a value`)
      return v
    }
    if (a === "--check") out.check = true
    else if (a === "--manifest") out.manifest = next()
    else if (a === "--stop-after-phase") {
      out.stopAfterPhase = next()
      if (!PHASES.some((p) => p.name === out.stopAfterPhase)) throw new DataCopyError("usage", `unknown phase; one of: ${PHASES.map((p) => p.name).join(", ")}`)
    } else if (a === "--batch-size") {
      out.batchSize = Number(next())
      if (!Number.isInteger(out.batchSize) || out.batchSize < 1 || out.batchSize > 50_000) throw new DataCopyError("usage", "--batch-size must be 1..50000")
    } else if (a === "--source-mode") out.sourceMode = next()
    else throw new DataCopyError("usage", `unknown argument: ${a}`)
  }
  return out
}

export async function main(argv: string[], env: Record<string, string | undefined>, root: string): Promise<number> {
  const secrets = [urlPassword(env.CARTOONA_COPY_SOURCE_URL), urlPassword(env.CARTOONA_COPY_TARGET_URL)]
  const err = (line: string) => process.stderr.write(redact(line, secrets) + "\n")
  try {
    const args = parseArgs(argv)
    const refFile = path.join(root, "supabase/.temp/project-ref")
    const linkedProjectRef = fs.existsSync(refFile) ? fs.readFileSync(refFile, "utf8").trim() : null
    if (args.check) {
      const { source, target } = validateTargets({
        sourceUrl: env.CARTOONA_COPY_SOURCE_URL,
        targetUrl: env.CARTOONA_COPY_TARGET_URL,
        sourceMode: args.sourceMode,
        env,
        linkedProjectRef,
      })
      process.stdout.write(`data-copy --check: source ${source.label} -> target ${target.label} (passwords not shown); nothing connected\n`)
      return 0
    }
    const result = await runDataCopy({
      sourceUrl: env.CARTOONA_COPY_SOURCE_URL,
      targetUrl: env.CARTOONA_COPY_TARGET_URL,
      migrationsDir: path.join(root, "database/migrations"),
      sourceMode: args.sourceMode,
      env,
      linkedProjectRef,
      batchSize: args.batchSize,
      stopAfterPhase: args.stopAfterPhase,
      manifestPath: args.manifest,
      log: err,
    })
    process.stdout.write(`data-copy: ${result.outcome} (run ${result.manifest.runId})\n`)
    return 0
  } catch (e) {
    if (e instanceof DataCopyError) {
      err(`data-copy: REFUSED/FAILED [${e.code}] ${e.message}`)
      for (const d of e.details) err(`  - ${d}`)
      return e.exitCode
    }
    err(`data-copy: unexpected error: ${String((e as Error)?.message ?? e)}`)
    return 1
  }
}

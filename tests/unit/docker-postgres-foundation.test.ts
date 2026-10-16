import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  composeSection,
  composeService,
  composeServiceNames,
  withoutYamlComments,
} from "../helpers/compose-text"

/**
 * Static guards for the V0.1.37 local PostgreSQL foundation.
 *
 * The service is infrastructure only — "prepared but not wired" — so these
 * pin both halves: the database is configured safely, and nothing in the app
 * has started depending on it. Assertions target properties, not file text.
 */

const root = path.resolve(__dirname, "../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")

const compose = withoutYamlComments(read("compose.yml"))
const postgres = composeService(compose, "postgres")
// The Next.js service was renamed app -> frontend in V0.1.40.
const app = composeService(compose, "frontend")
const template = read(".env.docker.example")

/** `KEY: value` inside a service's `environment:` map. */
const envValue = (block: string, key: string) =>
  new RegExp(`^\\s+${key}:\\s*(.+)$`, "m").exec(block)?.[1].trim()

/** `- "..."` entries under a service's `ports:`. */
const portEntries = (block: string) => {
  const lines = block.split("\n")
  const start = lines.findIndex((l) => /^\s+ports:\s*$/.test(l))
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s*"?([^"]+)"?\s*$/.exec(line)
    if (!m) break
    out.push(m[1])
  }
  return out
}

const templateVar = (name: string) =>
  new RegExp(`^${name}=(.*)$`, "m").exec(template)?.[1]

describe("compose.yml — postgres service", () => {
  it("defines a postgres service alongside frontend and backend", () => {
    expect(composeServiceNames(compose)).toEqual(["frontend", "backend", "postgres"])
    expect(postgres).not.toBe("")
  })

  it("pins postgres:17-bookworm, never latest", () => {
    expect(postgres).toMatch(/^\s+image:\s*postgres:17-bookworm\s*$/m)
    expect(compose).not.toMatch(/:latest\b/)
  })

  it("stores data in a named volume, not a bind mount into the repo", () => {
    expect(postgres).toMatch(/^\s+-\s*postgres_data:\/var\/lib\/postgresql\/data\s*$/m)
    // A bind mount would start with ./ ../ / or ~ — none may target the data dir.
    expect(postgres).not.toMatch(/-\s*["']?(\.{1,2}\/|\/|~)[^:]*:\/var\/lib\/postgresql/)
    const volumes = composeSection(compose, "volumes").join("\n")
    expect(volumes).toMatch(/^ {2}postgres_data:\s*$/m)
    expect(volumes).toMatch(/^\s+name:\s*cartoona_postgres_data\s*$/m)
  })

  it("hard-codes no password — only interpolation, with no default value", () => {
    expect(envValue(postgres, "POSTGRES_PASSWORD")).toBe("${POSTGRES_PASSWORD:-}")
    expect(envValue(postgres, "PGPASSWORD")).toBe("${POSTGRES_PASSWORD:-}")
    expect(envValue(postgres, "POSTGRES_DB")).toBe("${POSTGRES_DB:-cartoona}")
    expect(envValue(postgres, "POSTGRES_USER")).toBe("${POSTGRES_USER:-cartoona}")
  })

  it("never uses trust auth — scram-sha-256 for socket and TCP", () => {
    expect(compose).not.toMatch(/POSTGRES_HOST_AUTH_METHOD/)
    expect(compose).not.toMatch(/\btrust\b/)
    const initdb = envValue(postgres, "POSTGRES_INITDB_ARGS") ?? ""
    expect(initdb).toMatch(/--auth-local=scram-sha-256/)
    expect(initdb).toMatch(/--auth-host=scram-sha-256/)
  })

  it("does not pass the app's env file (and its Supabase secrets) to the database", () => {
    expect(postgres).not.toMatch(/env_file:/)
    expect(postgres).not.toMatch(/SUPABASE/)
  })

  it("publishes to loopback only, host 5433 -> container 5432", () => {
    const ports = portEntries(postgres)
    expect(ports).toEqual(["127.0.0.1:5433:5432"])
    for (const port of ports) expect(port.startsWith("127.0.0.1:")).toBe(true)
  })

  it("has a pg_isready healthcheck over TCP with the agreed timings", () => {
    expect(postgres).toMatch(/healthcheck:/)
    // `$$` is Compose's escape, so the container's shell expands the variable.
    // Quotes appear backslash-escaped inside the YAML string.
    expect(postgres).toMatch(
      /pg_isready -h 127\.0\.0\.1 -U \\?"\$\$\{POSTGRES_USER\}\\?" -d \\?"\$\$\{POSTGRES_DB\}\\?"/,
    )
    expect(postgres).toMatch(/interval: 5s/)
    expect(postgres).toMatch(/timeout: 5s/)
    expect(postgres).toMatch(/retries: 10/)
    expect(postgres).toMatch(/start_period: 10s/)
  })
})

describe("compose.yml — frontend (formerly app) is functionally unchanged", () => {
  it("still builds, publishes and health-checks the web app as before", () => {
    expect(app).toMatch(/dockerfile: Dockerfile/)
    expect(app).toMatch(/image: cartoona-app:local/)
    expect(portEntries(app)).toEqual(["3000:3000"])
    expect(app).toMatch(/test: \["CMD", "node", "healthcheck\.mjs"\]/)
  })

  it("does not depend on postgres — an unhealthy database cannot block startup", () => {
    expect(app).not.toMatch(/depends_on/)
    // V0.1.41: the only places the frontend block may name a database variable
    // are `NAME: ""` entries that BLANK what env_file would otherwise leak.
    const mentions = app.split("\n").filter((l) => /postgres|DATABASE_URL|APP_DB_PASSWORD/i.test(l))
    expect(mentions.length).toBeGreaterThan(0)
    for (const line of mentions) expect(line).toMatch(/^\s+[A-Z_]+:\s*""\s*$/)
  })
})

describe(".env.docker.example — local PostgreSQL placeholders", () => {
  it("declares the database variables with placeholder secrets", () => {
    expect(templateVar("POSTGRES_DB")).toBe("cartoona")
    expect(templateVar("POSTGRES_USER")).toBe("cartoona")
    expect(templateVar("POSTGRES_PASSWORD")).toBe("your-postgres-password")
  })

  it("addresses the database by service name inside Docker, by loopback:5433 from the host", () => {
    expect(templateVar("DATABASE_URL")).toBe(
      "postgresql://cartoona:your-postgres-password@postgres:5432/cartoona",
    )
    expect(templateVar("LOCAL_DATABASE_URL")).toBe(
      "postgresql://cartoona:your-postgres-password@localhost:5433/cartoona",
    )
  })

  it("separates current Supabase variables from the prepared PostgreSQL ones", () => {
    const supabase = template.indexOf("CURRENT — Supabase")
    const local = template.indexOf("LOCAL POSTGRESQL")
    expect(supabase).toBeGreaterThan(-1)
    expect(local).toBeGreaterThan(supabase)
    expect(template.indexOf("POSTGRES_PASSWORD=")).toBeGreaterThan(template.lastIndexOf("LOCAL POSTGRESQL"))
  })

  it("keeps every Supabase variable", () => {
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_SITE_URL",
      "SUPABASE_SECRET_KEY",
      "SUPABASE_PROJECT_REF",
    ]) {
      expect(templateVar(name), name).toBeDefined()
    }
    expect(app).toMatch(/NEXT_PUBLIC_SUPABASE_URL: \$\{NEXT_PUBLIC_SUPABASE_URL:-\}/)
    expect(app).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY: \$\{NEXT_PUBLIC_SUPABASE_ANON_KEY:-\}/)
  })

  it("keeps .env.docker, which holds the real password, gitignored", () => {
    const rules = read(".gitignore")
      .split("\n")
      .map((l) => l.trim())
    expect(rules).toContain(".env*")
    expect(rules).not.toContain("!.env.docker")
  })
})

describe("prepared, not wired", () => {
  /** Every source file the app itself is built from. */
  function appSources(): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(rel)
      }
    }
    for (const dir of ["app", "lib", "components", "config"]) {
      if (fs.existsSync(path.join(root, dir))) walk(dir)
    }
    for (const file of ["middleware.ts", "next.config.ts"]) {
      if (fs.existsSync(path.join(root, file))) out.push(file)
    }
    return out
  }

  it("only the lazy data-access pool reads DATABASE_URL; nothing reads the POSTGRES_* variables", () => {
    // V0.1.39: lib/db/pool.ts reads DATABASE_URL at first use (never at import),
    // and no route or page uses it yet (see db-layer-static.test.ts).
    const sources = appSources()
    expect(sources.length).toBeGreaterThan(50)
    const offenders = sources.filter((file) =>
      /\b(DATABASE_URL|LOCAL_DATABASE_URL|POSTGRES_(DB|USER|PASSWORD))\b/.test(read(file)),
    )
    expect(offenders).toEqual([path.join("lib", "db", "pool.ts")])
    expect(read("lib/db/pool.ts")).not.toMatch(/LOCAL_DATABASE_URL|POSTGRES_(DB|USER|PASSWORD)/)
  })

  it("installs the pg driver only: no other client and no ORM", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.dependencies.pg).toBeDefined()
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const name of [
      "postgres",
      "@prisma/client",
      "prisma",
      "drizzle-orm",
      "sequelize",
      "typeorm",
      "kysely",
      "knex",
    ]) {
      expect(deps[name], name).toBeUndefined()
    }
  })
})

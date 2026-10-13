/**
 * Provider-neutral structured logger.
 *
 * One JSON object per event. Nothing here knows about any monitoring vendor:
 * a vendor integration later only has to supply a different `LogSink`.
 *
 * Safety model - ALLOW-LIST, not deny-list. Every field passes through a
 * validator that accepts only a narrow, machine-shaped value (UUID, slug,
 * enum, bounded integer). Anything else - unknown keys, free text, emails,
 * phone numbers, tokens, paths, URLs - fails its validator and is dropped, so
 * a caller cannot leak by accident. There is deliberately no "extra metadata"
 * escape hatch.
 *
 * Edge-safe (no Node imports): used from middleware as well as route handlers.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export const SUBSYSTEMS = ["request", "auth", "database", "storage", "audit"] as const
export type Subsystem = (typeof SUBSYSTEMS)[number]

export interface LogFields {
  requestId?: string
  route?: string
  method?: string
  status?: number
  durationMs?: number
  errorCode?: string
  subsystem?: Subsystem
  operation?: string
  orderId?: string
  mediaAssetId?: string
  userRole?: string
  bucket?: string
  mediaType?: string
  reason?: string
  replayed?: boolean
  itemCount?: number
  failedCount?: number
  policy?: string
  paymentSource?: string
  retryAfterSeconds?: number
}

export interface LogRecord extends LogFields {
  timestamp: string
  level: LogLevel
  event: string
}

export type LogSink = (record: LogRecord) => void

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/
const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[A-Za-z0-9/_\-[\].]{0,150}$/
const METHOD = /^[A-Z]{3,7}$/
const MIME = /^[a-z]+\/[a-z0-9.+-]{1,60}$/
const ROLES = ["parent", "admin", "super_admin", "anonymous", "other"]

const str = (re: RegExp) => (v: unknown) => (typeof v === "string" && re.test(v) ? v : undefined)
const count = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : undefined

const VALIDATORS: { [K in keyof LogFields]-?: (v: unknown) => LogFields[K] | undefined } = {
  requestId: str(REQUEST_ID),
  route: str(ROUTE),
  method: str(METHOD),
  status: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined),
  durationMs: (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : undefined,
  errorCode: str(CODE),
  subsystem: (v) => (SUBSYSTEMS as readonly unknown[]).includes(v) ? (v as Subsystem) : undefined,
  operation: str(CODE),
  orderId: str(UUID),
  mediaAssetId: str(UUID),
  userRole: (v) => (typeof v === "string" && ROLES.includes(v) ? v : undefined),
  bucket: str(CODE),
  mediaType: str(MIME),
  reason: str(CODE),
  replayed: (v) => (typeof v === "boolean" ? v : undefined),
  itemCount: count,
  failedCount: count,
  policy: str(CODE),
  paymentSource: (v) => (v === "candy" || v === "welcome_image_credit" ? v : undefined),
  retryAfterSeconds: count,
}

// Fixed order -> stable, greppable output.
const FIELD_ORDER = Object.keys(VALIDATORS) as (keyof LogFields)[]
const EVENT = /^[A-Z][A-Z0-9_]{2,63}$/

export function sanitizeFields(fields: Record<string, unknown> = {}): LogFields {
  const out: Record<string, unknown> = {}
  for (const key of FIELD_ORDER) {
    const value = VALIDATORS[key](fields[key])
    if (value !== undefined) out[key] = value
  }
  return out as LogFields
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function minLevel(): LogLevel {
  const configured = typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined
  return configured && configured in LEVEL_RANK ? (configured as LogLevel) : "info"
}

const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record)
  if (record.level === "error") console.error(line)
  else if (record.level === "warn") console.warn(line)
  else console.log(line)
}

let sink: LogSink = consoleSink

/** Swap the sink (tests, or a future vendor adapter). Returns a restore fn. */
export function setLogSink(next: LogSink | null): () => void {
  const previous = sink
  sink = next ?? consoleSink
  return () => {
    sink = previous
  }
}

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  try {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return
    sink({
      timestamp: new Date().toISOString(),
      level,
      event: EVENT.test(event) ? event : "INVALID_EVENT_NAME",
      ...sanitizeFields(fields),
    })
  } catch {
    // Logging must never break a request.
  }
}

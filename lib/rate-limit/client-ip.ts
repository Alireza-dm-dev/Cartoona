import "server-only"
import { isIP } from "node:net"

/**
 * Conservative client-IP key for the (rare) endpoints that have no
 * authenticated identity to key by.
 *
 * The hosting provider is not decided, so NO forwarding header is trusted by
 * default: X-Forwarded-For & co. are plain client-controlled headers unless a
 * proxy you control overwrites them, and trusting them blindly lets anyone pick
 * their own rate-limit bucket. A deployer opts in by naming the one header their
 * proxy sets:
 *
 *   RATE_LIMIT_TRUSTED_IP_HEADER=x-forwarded-for   (or x-real-ip, cf-connecting-ip, ...)
 *
 * For a comma-separated list (x-forwarded-for) the RIGHTMOST entry is used: it
 * is the address the nearest trusted proxy actually observed, whereas entries
 * to its left can be forged by the client. This assumes exactly one trusted
 * proxy hop; with more, put the extra hops' handling in the proxy itself.
 *
 * When no trusted header is configured or the value is not a valid IP, every
 * such request shares ONE fallback bucket. That is deliberately strict and
 * deterministic (it can never be sidestepped by sending junk headers); it just
 * means public-IP limits are global until a trusted header is configured.
 *
 * The raw address never leaves this module: it is normalized, then keyed with an
 * HMAC and only a truncated digest is returned, so neither logs nor the store
 * ever see it.
 */

export const FALLBACK_IP_KEY = "ip:unknown"

let processSecret: string | null = null

function hashSecret(): string {
  const configured = process.env.RATE_LIMIT_HASH_SECRET
  if (configured && configured.length >= 16) return configured
  // No shared secret configured: a random per-process one still prevents
  // reversing the digest. A distributed store needs RATE_LIMIT_HASH_SECRET so
  // all instances derive the same key for the same client.
  processSecret ??= crypto.randomUUID() + crypto.randomUUID()
  return processSecret
}

/** Expand an IPv6 address to 8 hextets (no embedded-IPv4 support needed here). */
function expandIpv6(ip: string): string[] | null {
  let addr = ip
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (v4) {
    const parts = v4[1].split(".").map(Number)
    if (parts.some((n) => n > 255)) return null
    addr = addr.slice(0, -v4[1].length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = addr.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...tail]
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
}

/** Normalize to a canonical string, or null if it is not a valid IP. IPv6 collapses to its /64. */
export function normalizeIp(raw: string): string | null {
  let value = raw.trim()
  if (!value || value.length > 64) return null
  // [v6]:port  |  v4:port
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracket) value = bracket[1]
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"))
  value = value.split("%")[0] // zone id

  const family = isIP(value)
  if (family === 4) return value
  if (family === 6) {
    const groups = expandIpv6(value)
    if (!groups) return null
    // IPv4-mapped (::ffff:a.b.c.d) is the same client as the IPv4 address.
    if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
      const hi = parseInt(groups[6], 16), lo = parseInt(groups[7], 16)
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
    }
    // A /64 is one subscriber; privacy-extension addresses rotate inside it.
    return groups.slice(0, 4).join(":") + "::/64"
  }
  return null
}

/** The IP according to the operator-configured trusted header, or null. */
export function trustedClientIp(headers: Pick<Headers, "get">): string | null {
  const name = process.env.RATE_LIMIT_TRUSTED_IP_HEADER?.trim().toLowerCase()
  if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) return null
  const header = headers.get(name)
  if (!header || header.length > 512) return null
  const candidate = header.split(",").pop() ?? ""
  return normalizeIp(candidate)
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(hashSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))
  return Array.from(sig.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Opaque, fixed-length rate-limit key for an unauthenticated caller. Never the raw IP. */
export async function clientIpRateLimitKey(headers: Pick<Headers, "get">): Promise<string> {
  const ip = trustedClientIp(headers)
  if (!ip) return FALLBACK_IP_KEY
  return `ip:${await hmacHex(ip)}`
}

/**
 * Pure, sanitized analysis of Supabase access-token AMR claims (V0.1.54).
 * Input: two decoded claim objects (before / after a refresh). Output: ONLY
 * booleans, method names and integer second deltas - never a token, subject,
 * phone, e-mail, session id or absolute timestamp.
 */
export function analyzeAmr(before, after) {
  const entries = (c) => (Array.isArray(c?.amr) ? c.amr : [])
  const stamp = (e) => (e && Number.isSafeInteger(e.timestamp) && e.timestamp > 0 ? e.timestamp : null)
  const earliest = (c) => {
    const t = entries(c).map(stamp).filter((x) => x !== null)
    return t.length ? Math.min(...t) : null
  }
  const b = earliest(before)
  const a = earliest(after)
  const iatChanged = Number.isSafeInteger(before?.iat) && Number.isSafeInteger(after?.iat) && before.iat !== after.iat
  const methods = [...new Set(entries(before).map((e) => (typeof e?.method === "string" ? e.method.slice(0, 32) : "?")))].sort()
  const issues = []
  if (entries(before).length === 0) issues.push("amr_missing")
  else if (b === null) issues.push("amr_timestamp_missing")
  if (!iatChanged) issues.push("refresh_did_not_change_iat")
  if (b !== null && a === null) issues.push("amr_timestamp_lost_after_refresh")
  if (b !== null && a !== null && a !== b) issues.push("earliest_amr_timestamp_moved_on_refresh")
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    methods,
    amrPresent: entries(before).length > 0,
    timestampPresent: b !== null,
    iatChangedOnRefresh: iatChanged,
    earliestAmrStableAcrossRefresh: b !== null && a === b,
    amrAgeSecondsAtCheck: b === null ? null : Math.max(0, nowSec - b),
    stable: issues.length === 0,
    issues,
  }
}

export function decodeClaims(jwt) {
  const part = String(jwt).split(".")[1]
  if (!part) throw new Error("not a JWT")
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
}

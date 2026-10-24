/**
 * The persisted identity of ONE logical submission attempt (V0.1.50).
 *
 * Why this exists. The submission key is what stops a second charge: the
 * database returns the ORIGINAL order for a key it has seen. Until V0.1.50 the
 * key lived only in a React ref, so anything that rebuilt the component
 * (reload, navigating away and back, a second tab) minted a NEW key, and an
 * explicit resubmit after a lost answer could charge twice. Re-selecting the
 * file also reset it.
 *
 * Rules (all pure; the storage is injected):
 *
 *  - The record is {key, draftHash, uncertain}, written BEFORE the first send,
 *    so a reload while the request is in flight still finds the key.
 *  - The same draft always gets the same key. A file (re)selection is NOT an
 *    identity change: the key does not depend on the file, and the database
 *    replays by key whatever file accompanies it.
 *  - The key is dropped only when the outcome is KNOWN: a confirmed order, or a
 *    refusal that created nothing (validation, insufficient candy, ...).
 *  - After a lost answer (timeout, network, 5xx, unreadable 2xx) the record is
 *    marked `uncertain` and kept. A retry uses the SAME key (new assertion,
 *    new nonce on the server side), so it cannot charge twice.
 *  - A DIFFERENT draft while an uncertain record exists never silently gets a
 *    new key: the caller must first resolve the old key (see `staleAttempt`).
 *
 * Nothing here mints a key on its own initiative: `begin` is called by a
 * deliberate submit click.
 */

export const SUBMISSION_ATTEMPT_STORAGE_KEY = "cartoona.submission-attempt.v1"

export interface SubmissionAttempt {
  key: string
  draftHash: string
  uncertain: boolean
}

export interface AttemptStore {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
  removeItem(name: string): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A fresh v4 UUID for a new submission key. `crypto.randomUUID` exists only in
 * secure contexts (https, localhost); an http origin would throw before
 * anything was sent, so fall back to getRandomValues (same entropy source).
 */
export function mintSubmissionKey(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Deterministic JSON (sorted keys) so two renders of one draft hash alike. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
}

/** FNV-1a over the canonical draft: identity, not security. */
export function hashDraft(draft: unknown): string {
  const text = canonical(draft)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0") + text.length.toString(16)
}

export function readAttempt(store: AttemptStore | null): SubmissionAttempt | null {
  try {
    const raw = store?.getItem(SUBMISSION_ATTEMPT_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SubmissionAttempt>
    if (typeof v.key !== "string" || !UUID.test(v.key)) return null
    if (typeof v.draftHash !== "string" || typeof v.uncertain !== "boolean") return null
    return { key: v.key, draftHash: v.draftHash, uncertain: v.uncertain }
  } catch {
    return null
  }
}

function write(store: AttemptStore | null, attempt: SubmissionAttempt): void {
  try {
    store?.setItem(SUBMISSION_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt))
  } catch {
    // Storage blocked/full: the in-memory copy still protects this page load.
  }
}

export function clearAttempt(store: AttemptStore | null): void {
  try {
    store?.removeItem(SUBMISSION_ATTEMPT_STORAGE_KEY)
  } catch {
    // nothing to clear
  }
}

/**
 * An uncertain attempt belonging to a DIFFERENT draft than `draftHash`: the
 * caller must resolve it (lookup by key) before this draft may get a key of its
 * own, because the old order may exist. Null when there is nothing to resolve.
 */
export function staleAttempt(store: AttemptStore | null, draftHash: string): SubmissionAttempt | null {
  const a = readAttempt(store)
  return a && a.draftHash !== draftHash && a.uncertain ? a : null
}

/**
 * The key for this submit click. Reuses the stored key for the same draft
 * (whatever its state); otherwise mints one and persists it BEFORE returning,
 * so the key survives a reload during the send. A record for another draft is
 * replaced only when it is not uncertain (use `staleAttempt` first).
 */
export function beginAttempt(
  store: AttemptStore | null,
  draftHash: string,
  mint: () => string,
  memory?: { current: SubmissionAttempt | null },
): SubmissionAttempt {
  const stored = readAttempt(store) ?? memory?.current ?? null
  if (stored && stored.draftHash === draftHash) {
    if (memory) memory.current = stored
    return stored
  }
  const fresh: SubmissionAttempt = { key: mint(), draftHash, uncertain: false }
  write(store, fresh)
  if (memory) memory.current = fresh
  return fresh
}

/** The answer was lost: keep the key, remember that an order may exist. */
export function markUncertain(store: AttemptStore | null, attempt: SubmissionAttempt, memory?: { current: SubmissionAttempt | null }): void {
  const next = { ...attempt, uncertain: true }
  write(store, next)
  if (memory) memory.current = next
}

/** The outcome is known (order confirmed, or nothing was created): forget the key. */
export function endAttempt(store: AttemptStore | null, memory?: { current: SubmissionAttempt | null }): void {
  clearAttempt(store)
  if (memory) memory.current = null
}

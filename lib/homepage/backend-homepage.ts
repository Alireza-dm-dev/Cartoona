import "server-only"

import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter"
import { callGet, callWrite, type CallFailure } from "@/lib/backend/call"
import type { HomepageMediaWireRow } from "@/lib/admin/homepage/media-overview"

/**
 * The homepage CMS through the backend (V0.1.53). The public read is anonymous
 * (public content, object KEYS and a layout rectangle: nothing private); the
 * admin writes carry a v3 assertion for the verified admin. No Supabase table.
 */

export interface HomepageWireData {
  content: { contentJson: unknown; revision: number } | null
  media: HomepageMediaWireRow[]
  heroLayout: { tvRect: unknown; revision: number } | null
}

/** null = the backend could not answer (callers fall back to the bundled defaults). */
export async function fetchHomepageData(): Promise<HomepageWireData | null> {
  const r = await callGet(null, "homepage_public", "/v1/public/homepage")
  if (!r.ok) return null
  const b = r.body
  if (!Array.isArray(b.media)) return null
  const c = b.content as Record<string, unknown> | null
  const l = b.heroLayout as Record<string, unknown> | null
  return {
    content: c && typeof c.revision === "number" ? { contentJson: c.contentJson, revision: c.revision } : null,
    media: (b.media as Record<string, unknown>[]).map((m) => ({
      slotKey: String(m.slotKey ?? ""),
      mediaType: String(m.mediaType ?? ""),
      storagePath: String(m.storagePath ?? ""),
      mimeType: String(m.mimeType ?? ""),
      byteSize: Number(m.byteSize ?? 0),
      width: typeof m.width === "number" ? m.width : null,
      height: typeof m.height === "number" ? m.height : null,
      durationSeconds: typeof m.durationSeconds === "number" ? m.durationSeconds : null,
      updatedAt: typeof m.updatedAt === "string" ? m.updatedAt : "",
    })),
    heroLayout: l && typeof l.revision === "number" ? { tvRect: l.tvRect, revision: l.revision } : null,
  }
}

export type BackendRefusal = { token: string; status: number }
export type WriteOutcome<T> = { ok: true; value: T } | { ok: false; refusal: BackendRefusal } | { ok: false; failure: Exclude<CallFailure, { kind: "refused" }> }

function fold<T>(r: Awaited<ReturnType<typeof callWrite>>, pick: (body: Record<string, unknown>) => T | null): WriteOutcome<T> {
  if (r.ok) {
    const v = pick(r.body)
    return v === null ? { ok: false, failure: { ok: false, kind: "unavailable", outcomeUnknown: true } } : { ok: true, value: v }
  }
  if (r.kind === "refused") return { ok: false, refusal: { token: r.error, status: r.status } }
  return { ok: false, failure: r }
}

export async function saveHomepageContent(
  context: VerifiedAuthContext,
  content: unknown,
  expectedRevision: number,
): Promise<WriteOutcome<{ contentJson: unknown; revision: number; updatedAt: string }>> {
  const r = await callWrite(context, "homepage_update", "PUT", "/v1/admin/homepage", { content, expectedRevision })
  return fold(r, (b) => (typeof b.revision === "number" ? { contentJson: b.contentJson, revision: b.revision, updatedAt: String(b.updatedAt ?? "") } : null))
}

export interface RecordMediaBody {
  slot: string
  mediaType: string
  storagePath: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  tvRect: unknown | null
  expectedLayoutRevision: number | null
  applyToSections: boolean
}

export async function recordHomepageMedia(context: VerifiedAuthContext, body: RecordMediaBody): Promise<WriteOutcome<unknown>> {
  const r = await callWrite(context, "homepage_media_record", "POST", "/v1/admin/homepage/media", body)
  return fold(r, (b) => (b.result ? b.result : null))
}

export async function revertHomepageMedia(context: VerifiedAuthContext, slot: string): Promise<WriteOutcome<{ storage_path?: unknown }>> {
  const r = await callWrite(context, "homepage_media_delete", "DELETE", "/v1/admin/homepage/media", { slot })
  return fold(r, (b) => (b.result && typeof b.result === "object" ? (b.result as { storage_path?: unknown }) : null))
}

export async function saveHeroLayout(context: VerifiedAuthContext, rect: unknown, expectedRevision: number): Promise<WriteOutcome<{ tv_rect: unknown; revision: number }>> {
  const r = await callWrite(context, "homepage_hero_layout", "PUT", "/v1/admin/homepage/hero-layout", { rect, expectedRevision })
  return fold(r, (b) => {
    const x = b.result as { tv_rect: unknown; revision: number } | undefined
    return x && typeof x.revision === "number" ? x : null
  })
}

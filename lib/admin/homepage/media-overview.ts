import {
  HOMEPAGE_MEDIA_SLOT_SPECS,
  HOMEPAGE_MEDIA_SLOT_VALUES,
} from "@/lib/homepage/media-slots"
import { validateHeroTvRect, type HeroTvRect } from "@/lib/homepage/hero-layout"
import {
  isSharedBackground,
  toSafeSlotRecord,
  type MediaRowSnapshot,
  type SafeSlotRecord,
} from "@/lib/admin/homepage/media-validation"

/**
 * The admin/public view of the homepage media rows (V0.1.53: pure, built from the
 * rows the backend returned; it used to be a Supabase read). No I/O, no
 * framework: unit-testable, and shared by the public resolver and the admin
 * manager so they can never disagree about a slot.
 */

export interface AdminMediaSlotView extends SafeSlotRecord {
  label: string
  geometryCoupled: boolean
  currentPublicPath: string
}

export interface AdminMediaOverview {
  slots: AdminMediaSlotView[]
  heroLayout: { rect: HeroTvRect; revision: number } | null
  sharedBackground: boolean
}

/** The rows `GET /v1/public/homepage` returns (camelCase wire form). */
export interface HomepageMediaWireRow {
  slotKey: string
  mediaType: string
  storagePath: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  durationSeconds: number | null
  updatedAt: string
}

export function toSnapshot(row: HomepageMediaWireRow): MediaRowSnapshot {
  return {
    slot_key: row.slotKey,
    media_type: row.mediaType,
    storage_path: row.storagePath,
    mime_type: row.mimeType,
    byte_size: row.byteSize,
    width: row.width,
    height: row.height,
    duration_seconds: row.durationSeconds,
    updated_at: row.updatedAt || new Date(0).toISOString(),
  }
}

export function buildMediaOverview(
  rows: HomepageMediaWireRow[],
  layout: { tvRect: unknown; revision: number } | null,
  publicUrl: (storagePath: string) => string,
): AdminMediaOverview {
  const bySlot = new Map(rows.map((r) => [r.slotKey, toSnapshot(r)]))
  const slots: AdminMediaSlotView[] = HOMEPAGE_MEDIA_SLOT_VALUES.map((slot) => {
    const spec = HOMEPAGE_MEDIA_SLOT_SPECS[slot]
    const row = bySlot.get(slot)
    const previewUrl = row ? publicUrl(row.storage_path) : spec.currentPublicPath
    const base: SafeSlotRecord = row
      ? toSafeSlotRecord(row, previewUrl)
      : {
          slotKey: slot,
          mediaType: spec.mediaType,
          previewUrl,
          mimeType: "",
          byteSize: 0,
          width: null,
          height: null,
          durationSeconds: null,
          updatedAt: "",
        }
    return { ...base, label: spec.label, geometryCoupled: spec.geometryCoupled, currentPublicPath: spec.currentPublicPath }
  })
  const heroLayout =
    layout && validateHeroTvRect(layout.tvRect).length === 0 && typeof layout.revision === "number"
      ? { rect: layout.tvRect as HeroTvRect, revision: layout.revision }
      : null
  return {
    slots,
    heroLayout,
    sharedBackground: isSharedBackground(
      bySlot.get("hero.background")?.storage_path ?? null,
      bySlot.get("sections.background")?.storage_path ?? null,
    ),
  }
}

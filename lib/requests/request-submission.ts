import type { CreationDraft, ImageCreationDraft, VideoCreationDraft, DrawingCreationDraft } from "@/lib/creation/creation-draft"
import type { OrderType } from "@/types/app"
import { FORM_TO_INTERNAL, VIDEO_DURATION_TO_INTERNAL, isVideoDurationChoice } from "@/lib/pricing/pricing-keys"
import type { InternalDuration, VideoDurationChoice } from "@/lib/pricing/pricing-keys"

export interface NormalizedRequest {
  type: OrderType
  /**
   * Null for image and video requests, which no longer collect a title.
   * Never a placeholder: the column is nullable and the read models fall
   * back at display time.
   */
  title: string | null
  description: string
  characterId: string | null
  /** Internal pricing tier. Unchanged mapping, unchanged candy costs. */
  durationKey: InternalDuration | null
  /** Parent-facing duration choice, persisted verbatim for video requests. */
  durationChoice: VideoDurationChoice | null
  videoScript: string | null
  videoStyle: string | null
  animationStyle: string | null
  /** Required for new video requests. Null for every other type. */
  charactersSpeak: boolean | null
  fileName: string | null
}

export interface ParseError {
  field: string
  message: string
}

type ParseResult =
  | { ok: true; data: NormalizedRequest }
  | { ok: false; errors: ParseError[] }

function trimToNull(s: string | null | undefined): string | null {
  if (!s) return null
  const trimmed = s.trim()
  return trimmed.length > 0 ? trimmed : null
}

function collectErrors(checks: { field: string; valid: boolean; message: string }[]): ParseError[] {
  return checks.filter((c) => !c.valid).map((c) => ({ field: c.field, message: c.message }))
}

export function parseAndValidateDraft(raw: string): ParseResult {
  let draft: CreationDraft
  try {
    draft = JSON.parse(raw)
  } catch {
    return { ok: false, errors: [{ field: "draft", message: "داده‌ی ارسالی معتبر نیست" }] }
  }

  if (!draft || typeof draft !== "object") {
    return { ok: false, errors: [{ field: "draft", message: "داده‌ی درخواست باید یک شیء باشد" }] }
  }

  const versionErrors = collectErrors([
    { field: "version", valid: draft.version === 1, message: "نسخه‌ی پیش‌نویس پشتیبانی نمی‌شود" },
  ])
  if (versionErrors.length > 0) return { ok: false, errors: versionErrors }

  // Image and video no longer collect a title, so it is optional here and
  // stays null rather than being filled with generated text. Drawing
  // animation still has a title field and still requires one.
  const titleRaw = trimToNull((draft as { title?: string }).title)
  const title = titleRaw === null ? null : titleRaw.slice(0, 160)

  switch (draft.type) {
    case "image":
      return validateImageDraft(draft as ImageCreationDraft)
    case "video":
      return validateVideoDraft(draft as VideoCreationDraft)
    case "drawing": {
      const drawingTitleErrors = collectErrors([
        { field: "title", valid: title !== null, message: "عنوان درخواست الزامی است" },
      ])
      if (drawingTitleErrors.length > 0) return { ok: false, errors: drawingTitleErrors }
      return validateDrawingDraft(draft as DrawingCreationDraft, title!)
    }
    default:
      return { ok: false, errors: [{ field: "type", message: `نوع "${(draft as { type: string }).type}" پشتیبانی نمی‌شود` }] }
  }
}

function validateImageDraft(draft: ImageCreationDraft): ParseResult {
  const parts: string[] = []
  if (draft.sceneDescription) parts.push(`صحنه: ${draft.sceneDescription}`)
  if (draft.style) parts.push(`سبک: ${draft.style}`)
  if (draft.occasion) parts.push(`مناسبت: ${draft.occasion}`)
  if (draft.parentNote) parts.push(`یادداشت: ${draft.parentNote}`)
  const description = parts.join("\n\n")

  const characterId = trimToNull(draft.selectedCharacterId)
  const fileName = trimToNull(draft.referenceFileName)

  const errors = collectErrors([
    { field: "selectedCharacterId", valid: characterId !== null, message: "انتخاب شخصیت برای درخواست تصویر الزامی است" },
  ])
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    data: {
      type: "image",
      title: null,
      description,
      characterId,
      durationKey: null,
      durationChoice: null,
      videoScript: null,
      videoStyle: null,
      animationStyle: null,
      charactersSpeak: null,
      fileName,
    },
  }
}

function validateVideoDraft(draft: VideoCreationDraft): ParseResult {
  const storyTrimmed = trimToNull(draft.storyDescription)
  const characterId = trimToNull(draft.selectedCharacterId)
  const fileName = trimToNull(draft.referenceFileName)

  const occasionNote: string[] = []
  if (draft.occasion) occasionNote.push(`مناسبت: ${draft.occasion}`)
  if (draft.parentNote) occasionNote.push(`یادداشت: ${draft.parentNote}`)
  const description = occasionNote.join("\n\n")

  // An unrecognised duration stays null and is rejected below rather than
  // being coerced onto a tier, which would change what the parent pays.
  const durationChoice: VideoDurationChoice | null = isVideoDurationChoice(draft.duration)
    ? draft.duration
    : null
  const durationKey: InternalDuration | null = durationChoice
    ? VIDEO_DURATION_TO_INTERNAL[durationChoice]
    : null

  // Only a real boolean counts. "true", 1 and null are all malformed, and
  // none of them is guessed into a value.
  const charactersSpeak = typeof draft.charactersSpeak === "boolean" ? draft.charactersSpeak : null

  const errors = collectErrors([
    { field: "selectedCharacterId", valid: characterId !== null, message: "انتخاب شخصیت برای درخواست ویدیو الزامی است" },
    { field: "storyDescription", valid: storyTrimmed !== null, message: "توضیح داستان برای ویدیو الزامی است" },
    { field: "duration", valid: durationKey !== null, message: "مدت زمان ویدیو مشخص نشده است" },
    { field: "charactersSpeak", valid: charactersSpeak !== null, message: "لطفاً مشخص کنید کاراکترها صحبت کنند یا خیر" },
  ])
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    data: {
      type: "video",
      title: null,
      description,
      characterId,
      durationKey,
      durationChoice,
      videoScript: storyTrimmed,
      videoStyle: null,
      animationStyle: null,
      charactersSpeak,
      fileName,
    },
  }
}

function validateDrawingDraft(draft: DrawingCreationDraft, title: string): ParseResult {
  const movementTrimmed = trimToNull(draft.movementType)
  const fileName = trimToNull(draft.drawingFileName)

  const descParts: string[] = []
  if (draft.animationDescription) descParts.push(`توضیح متحرک‌سازی: ${draft.animationDescription}`)
  if (draft.backgroundScene) descParts.push(`صحنه‌ی پس‌زمینه: ${draft.backgroundScene}`)
  if (draft.parentNote) descParts.push(`یادداشت: ${draft.parentNote}`)
  const description = descParts.join("\n\n")

  let durationKey: InternalDuration | null = null
  if (draft.duration) {
    durationKey = FORM_TO_INTERNAL[draft.duration] ?? null
  }

  const errors = collectErrors([
    { field: "drawingFileName", valid: fileName !== null, message: "فایل نقاشی برای درخواست متحرک‌سازی الزامی است" },
    { field: "movementType", valid: movementTrimmed !== null, message: "نوع حرکت برای متحرک‌سازی الزامی است" },
    { field: "duration", valid: durationKey !== null, message: "مدت زمان متحرک‌سازی مشخص نشده است" },
  ])
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    data: {
      type: "drawing_animation",
      title,
      description,
      characterId: null,
      durationKey,
      durationChoice: null,
      videoScript: null,
      videoStyle: null,
      animationStyle: movementTrimmed,
      charactersSpeak: null,
      fileName,
    },
  }
}

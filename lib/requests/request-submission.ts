import type { CreationDraft, ImageCreationDraft, VideoCreationDraft, DrawingCreationDraft } from "@/lib/creation/creation-draft"
import type { OrderType } from "@/types/app"
import { FORM_TO_INTERNAL } from "@/lib/pricing/pricing-keys"
import type { InternalDuration } from "@/lib/pricing/pricing-keys"

export interface NormalizedRequest {
  type: OrderType
  title: string
  description: string
  characterId: string | null
  durationKey: InternalDuration | null
  videoScript: string | null
  videoStyle: string | null
  animationStyle: string | null
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

  const titleRaw = trimToNull(draft.title)
  const titleErrors = collectErrors([
    { field: "title", valid: titleRaw !== null, message: "عنوان درخواست الزامی است" },
  ])
  if (titleErrors.length > 0) return { ok: false, errors: titleErrors }

  const title = titleRaw!.slice(0, 160)

  switch (draft.type) {
    case "image":
      return validateImageDraft(draft as ImageCreationDraft, title)
    case "video":
      return validateVideoDraft(draft as VideoCreationDraft, title)
    case "drawing":
      return validateDrawingDraft(draft as DrawingCreationDraft, title)
    default:
      return { ok: false, errors: [{ field: "type", message: `نوع "${(draft as { type: string }).type}" پشتیبانی نمی‌شود` }] }
  }
}

function validateImageDraft(draft: ImageCreationDraft, title: string): ParseResult {
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
      title,
      description,
      characterId,
      durationKey: null,
      videoScript: null,
      videoStyle: null,
      animationStyle: null,
      fileName,
    },
  }
}

function validateVideoDraft(draft: VideoCreationDraft, title: string): ParseResult {
  const storyTrimmed = trimToNull(draft.storyDescription)
  const styleTrimmed = trimToNull(draft.style)
  const characterId = trimToNull(draft.selectedCharacterId)
  const fileName = trimToNull(draft.referenceFileName)

  const occasionNote: string[] = []
  if (draft.occasion) occasionNote.push(`مناسبت: ${draft.occasion}`)
  if (draft.parentNote) occasionNote.push(`یادداشت: ${draft.parentNote}`)
  const description = occasionNote.join("\n\n")

  let durationKey: InternalDuration | null = null
  if (draft.duration) {
    durationKey = FORM_TO_INTERNAL[draft.duration] ?? null
  }

  const errors = collectErrors([
    { field: "selectedCharacterId", valid: characterId !== null, message: "انتخاب شخصیت برای درخواست ویدیو الزامی است" },
    { field: "storyDescription", valid: storyTrimmed !== null, message: "توضیح داستان برای ویدیو الزامی است" },
    { field: "style", valid: styleTrimmed !== null, message: "سبک ویدیو الزامی است" },
    { field: "duration", valid: durationKey !== null, message: "مدت زمان ویدیو مشخص نشده است" },
  ])
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    data: {
      type: "video",
      title,
      description,
      characterId,
      durationKey,
      videoScript: storyTrimmed,
      videoStyle: styleTrimmed,
      animationStyle: null,
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
      videoScript: null,
      videoStyle: null,
      animationStyle: movementTrimmed,
      fileName,
    },
  }
}

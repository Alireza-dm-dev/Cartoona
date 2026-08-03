import type { ExampleKind } from "@/types/app"

const VALID_KINDS: ExampleKind[] = ["video", "drawing", "story"]
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function trimOrNull(value: FormDataEntryValue | null): string | null {
  if (!value || typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface ValidationError {
  field: string
  message: string
}

export interface CreateExampleInput {
  title: string
  badge_label: string
  description: string
  kind: ExampleKind
  sort_order: number
  is_published: boolean
}

export interface UpdateExampleInput {
  title?: string
  badge_label?: string
  description?: string
  kind?: ExampleKind
  sort_order?: number
  is_published?: boolean
}

export function validateExampleId(id: string): string | null {
  if (!UUID_REGEX.test(id)) {
    return "Invalid example ID format"
  }
  return null
}

const REJECTED_FIELDS = new Set([
  "created_by",
  "image_path",
  "media_url",
  "created_at",
  "updated_at",
  "id",
  "thumbnail_url",
])

export function validateCreateExampleForm(formData: FormData): { data?: CreateExampleInput; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  for (const key of formData.keys()) {
    if (REJECTED_FIELDS.has(key)) {
      errors.push({ field: key, message: "Field is not accepted" })
    }
  }

  const titleRaw = trimOrNull(formData.get("title"))
  if (!titleRaw) {
    errors.push({ field: "title", message: "Title is required" })
  } else if (titleRaw.length > 120) {
    errors.push({ field: "title", message: "Title must be at most 120 characters" })
  }

  const badgeLabelRaw = trimOrNull(formData.get("badge_label")) ?? ""
  if (badgeLabelRaw.length > 40) {
    errors.push({ field: "badge_label", message: "Badge label must be at most 40 characters" })
  }

  const descriptionRaw = trimOrNull(formData.get("description"))
  if (!descriptionRaw) {
    errors.push({ field: "description", message: "Description is required" })
  } else if (descriptionRaw.length > 1000) {
    errors.push({ field: "description", message: "Description must be at most 1000 characters" })
  }

  const kindRaw = formData.get("kind")
  if (!kindRaw || typeof kindRaw !== "string" || !VALID_KINDS.includes(kindRaw as ExampleKind)) {
    errors.push({ field: "kind", message: "Kind must be one of: video, drawing, story" })
  }

  const sortOrderRaw = formData.get("sort_order")
  const sortOrder = sortOrderRaw ? parseInt(String(sortOrderRaw), 10) : NaN
  if (isNaN(sortOrder) || sortOrder < 0 || sortOrder > 10000) {
    errors.push({ field: "sort_order", message: "Sort order must be an integer between 0 and 10000" })
  }

  const isPublishedRaw = formData.get("is_published")
  let isPublished = false
  if (isPublishedRaw !== null) {
    const val = String(isPublishedRaw).toLowerCase()
    if (val === "true" || val === "1") {
      isPublished = true
    } else if (val === "false" || val === "0") {
      isPublished = false
    } else {
      errors.push({ field: "is_published", message: "is_published must be a boolean" })
    }
  }

  if (errors.length > 0) {
    return { errors }
  }

  return {
    data: {
      title: titleRaw!,
      badge_label: badgeLabelRaw,
      description: descriptionRaw!,
      kind: kindRaw as ExampleKind,
      sort_order: sortOrder,
      is_published: isPublished,
    },
    errors: [],
  }
}

export function validateUpdateExampleJson(body: Record<string, unknown>): { data?: UpdateExampleInput; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  for (const key of Object.keys(body)) {
    if (REJECTED_FIELDS.has(key)) {
      errors.push({ field: key, message: "Field is not accepted" })
    }
  }

  const data: UpdateExampleInput = {}

  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      errors.push({ field: "title", message: "Title must be a string" })
    } else {
      const trimmed = body.title.trim()
      if (trimmed.length === 0) {
        errors.push({ field: "title", message: "Title must not be empty" })
      } else if (trimmed.length > 120) {
        errors.push({ field: "title", message: "Title must be at most 120 characters" })
      } else {
        data.title = trimmed
      }
    }
  }

  if (body.badge_label !== undefined) {
    if (typeof body.badge_label !== "string") {
      errors.push({ field: "badge_label", message: "Badge label must be a string" })
    } else if (body.badge_label.length > 40) {
      errors.push({ field: "badge_label", message: "Badge label must be at most 40 characters" })
    } else {
      data.badge_label = body.badge_label
    }
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      errors.push({ field: "description", message: "Description must be a string" })
    } else {
      const trimmed = body.description.trim()
      if (trimmed.length === 0) {
        errors.push({ field: "description", message: "Description must not be empty" })
      } else if (trimmed.length > 1000) {
        errors.push({ field: "description", message: "Description must be at most 1000 characters" })
      } else {
        data.description = trimmed
      }
    }
  }

  if (body.kind !== undefined) {
    if (typeof body.kind !== "string" || !VALID_KINDS.includes(body.kind as ExampleKind)) {
      errors.push({ field: "kind", message: "Kind must be one of: video, drawing, story" })
    } else {
      data.kind = body.kind as ExampleKind
    }
  }

  if (body.sort_order !== undefined) {
    const val = Number(body.sort_order)
    if (!Number.isInteger(val) || val < 0 || val > 10000) {
      errors.push({ field: "sort_order", message: "Sort order must be an integer between 0 and 10000" })
    } else {
      data.sort_order = val
    }
  }

  if (body.is_published !== undefined) {
    if (typeof body.is_published !== "boolean") {
      errors.push({ field: "is_published", message: "is_published must be a boolean" })
    } else {
      data.is_published = body.is_published
    }
  }

  if (errors.length > 0) {
    return { errors }
  }

  return { data, errors: [] }
}

export function validatePublishInput(body: unknown): { data?: { is_published: boolean }; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  if (!body || typeof body !== "object" || body === null) {
    errors.push({ field: "is_published", message: "Request body is required" })
    return { errors }
  }

  const obj = body as Record<string, unknown>

  if (typeof obj.is_published !== "boolean") {
    errors.push({ field: "is_published", message: "is_published must be a boolean" })
    return { errors }
  }

  return { data: { is_published: obj.is_published }, errors: [] }
}

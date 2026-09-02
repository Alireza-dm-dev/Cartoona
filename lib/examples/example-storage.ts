import type { SupabaseClient } from "@supabase/supabase-js"

export const EXAMPLE_MEDIA_BUCKET = "example-media"

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

const MAX_FILE_SIZE = 10 * 1024 * 1024

export function validateImageFile(file: File): string | null {
  if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
    return "Invalid file type. Only PNG, JPEG, and WebP images are allowed."
  }

  if (file.size > MAX_FILE_SIZE) {
    return "File size exceeds 10 MiB limit."
  }

  return null
}

export function buildStoragePath(exampleId: string, file: File): string {
  const ext = MIME_TO_EXT[file.type] || "png"
  const uuid = crypto.randomUUID()
  return `examples/${exampleId}/${uuid}.${ext}`
}

export async function uploadImage(
  supabase: SupabaseClient,
  path: string,
  file: File,
): Promise<void> {
  const { error } = await supabase.storage
    .from(EXAMPLE_MEDIA_BUCKET)
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    })

  if (error) {
    throw new Error("Failed to upload image")
  }
}

export async function deleteImage(
  supabase: SupabaseClient,
  path: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(EXAMPLE_MEDIA_BUCKET)
    .remove([path])

  if (error) {
    throw new Error("Failed to delete image")
  }
}

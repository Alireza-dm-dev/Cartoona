import { NextResponse } from "next/server"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { checkCurrentParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createExpiredParentSessionResponse } from "@/lib/auth/expired-parent-session-response"
import { parseAndValidateDraft } from "@/lib/requests/request-submission"
import { mapRequestRpcError } from "@/lib/requests/request-rpc-error"
import { toSubmissionSuccess } from "@/lib/requests/submission-response"
import { resolveCharacterId } from "@/lib/requests/resolve-character"
import { sanitizeFileName } from "@/lib/requests/sanitize-file-name"
import {
  resolveOwnedSourceAsset,
  sourceAssetCopyName,
  PRIVATE_UPLOADS_BUCKET,
} from "@/lib/parent/gallery/source-asset"

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"]
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MiB

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "فرمت درخواست باید multipart/form-data باشد." }, { status: 415 })
  }

  const supabase = await createServerSupabaseClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
  }

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || userRow.role !== "parent") {
    return NextResponse.json({ error: "فقط حساب‌های والد می‌توانند درخواست ثبت کنند" }, { status: 403 })
  }

  const lifetime = await checkCurrentParentSessionLifetime(supabase)
  if (!lifetime.valid) {
    return createExpiredParentSessionResponse(supabase)
  }

  const { data: parentProfile } = await supabase
    .from("parent_profiles")
    .select("id, consent_granted")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!parentProfile) {
    return NextResponse.json({ error: "پروفایل والد یافت نشد. لطفاً ابتدا رضایت خود را ثبت کنید" }, { status: 403 })
  }

  if (!parentProfile.consent_granted) {
    return NextResponse.json({ error: "لطفاً ابتدا رضایت والدین را ثبت کنید" }, { status: 403 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: "خطا در خواندن داده‌های ارسالی" }, { status: 400 })
  }

  const draftRaw = formData.get("draft")
  if (typeof draftRaw !== "string" || !draftRaw.trim()) {
    return NextResponse.json({ error: "داده‌ی درخواست ارسال نشده است" }, { status: 400 })
  }

  const parsed = parseAndValidateDraft(draftRaw)
  if (!parsed.ok) {
    return NextResponse.json({
      error: parsed.errors[0].message,
      code: "validation_error",
      fields: parsed.errors,
    }, { status: 422 })
  }

  const normalized = parsed.data

  // The draft names the character; the RPC needs its id. Resolved here, before
  // anything is uploaded, so an unknown character costs no storage write.
  const character = await resolveCharacterId(supabase, normalized.characterId)
  if (!character.ok) {
    return NextResponse.json(
      character.reason === "not_found"
        ? {
            error: "شخصیت انتخاب‌شده در دسترس نیست. لطفاً شخصیت دیگری انتخاب کنید.",
            code: "character_unavailable",
          }
        : {
            error: "ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.",
            code: "character_lookup_failed",
          },
      { status: character.reason === "not_found" ? 422 : 500 },
    )
  }

  const orderId = crypto.randomUUID()

  let storagePath: string | null = null
  let fileUploaded = false
  // The parent's own file name, recorded on the source row so the private
  // gallery can label it. The storage path cannot serve this purpose: it holds
  // the sanitized ASCII form, which is empty for a Persian name.
  let originalFilename: string | null = null

  const file = formData.get("file")
  const sourceAssetIdRaw = formData.get("sourceAssetId")

  const hasUpload =
    file !== null && typeof file === "object" && "size" in file && (file as File).size > 0
  const hasGalleryChoice =
    typeof sourceAssetIdRaw === "string" && sourceAssetIdRaw.trim().length > 0

  // Exactly one source, never two. Silently preferring the upload would make
  // the request disagree with what the parent chose on screen, so an ambiguous
  // submission is refused instead of resolved.
  if (hasUpload && hasGalleryChoice) {
    return NextResponse.json({
      error: "برای هر درخواست فقط یک فایل مجاز است: یا بارگذاری جدید، یا انتخاب از گالری.",
      code: "ambiguous_source",
    }, { status: 422 })
  }

  if (hasUpload) {
    const uploadedFile = file as File

    if (!ALLOWED_MIME_TYPES.includes(uploadedFile.type)) {
      return NextResponse.json({
        error: "فرمت فایل پشتیبانی نمی‌شود. فقط JPEG، PNG و WebP مجاز هستند.",
        code: "invalid_file_type",
      }, { status: 422 })
    }

    if (uploadedFile.size > MAX_FILE_SIZE) {
      return NextResponse.json({
        error: "حجم فایل نباید بیشتر از ۱۰ مگابایت باشد.",
        code: "file_too_large",
      }, { status: 422 })
    }

    const safeName = sanitizeFileName(uploadedFile.name)
    storagePath = `${user.id}/${orderId}/${safeName}`
    originalFilename = uploadedFile.name

    const { error: uploadError } = await supabase.storage
      .from("parent-uploads")
      .upload(storagePath, uploadedFile, {
        contentType: uploadedFile.type,
        upsert: false,
      })

    if (uploadError) {
      if (uploadError.message?.includes("row-level security")) {
        return NextResponse.json({
          error: "خطای دسترسی در بارگذاری فایل. لطفاً دوباره وارد شوید.",
          code: "storage_permission_denied",
        }, { status: 403 })
      }
      return NextResponse.json({
        error: "بارگذاری فایل با خطا مواجه شد. لطفاً دوباره تلاش کنید.",
        code: "upload_failed",
      }, { status: 500 })
    }

    fileUploaded = true
  } else if (hasGalleryChoice) {
    // ── Reuse of an existing private-gallery asset ────────────────────────
    // The browser sends a media_assets id and never a storage path, so the
    // path is resolved server-side from a row that is proven to belong to
    // this parent. The object is then copied into the new order's own folder,
    // which keeps the <uid>/<orderId>/ storage invariant the RPC and the
    // storage policies both depend on.
    {
      const sourceAssetId = (sourceAssetIdRaw as string).trim()
      const resolved = await resolveOwnedSourceAsset(supabase, sourceAssetId)

      if (!resolved.ok) {
        // A foreign id and a non-existent id answer identically, so this
        // cannot be used to probe another parent's media.
        return NextResponse.json({
          error: "فایل انتخاب‌شده در دسترس نیست. لطفاً دوباره انتخاب کنید یا فایل جدیدی بارگذاری کنید.",
          code: "source_asset_unavailable",
        }, { status: 422 })
      }

      const copyName = sourceAssetCopyName(resolved.asset, sanitizeFileName)
      storagePath = `${user.id}/${orderId}/${copyName}`
      // The copy inherits the label the parent already knows this file by.
      originalFilename = resolved.asset.originalFilename

      const { error: copyError } = await supabase.storage
        .from(PRIVATE_UPLOADS_BUCKET)
        .copy(resolved.asset.path, storagePath)

      if (copyError) {
        return NextResponse.json({
          error: "استفاده از فایل قبلی با خطا مواجه شد. لطفاً دوباره تلاش کنید.",
          code: "source_asset_copy_failed",
        }, { status: 500 })
      }

      // Marked as uploaded so the rollback below removes the copy, not the
      // original, if the request insert fails. storagePath is the new order's
      // own path, so the rollback can never reach the source asset.
      fileUploaded = true
    }
  }

  const { data: rpcData, error: rpcError } = await createAdminSupabaseClient()
    .rpc("create_parent_request_trusted", {
      p_parent_profile_id: parentProfile.id,
      p_order_id: orderId,
      p_type: normalized.type,
      p_title: normalized.title,
      p_description: normalized.description || null,
      p_character_id: character.characterId,
      p_duration_key: normalized.durationKey,
      p_video_script: normalized.videoScript,
      p_video_style: normalized.videoStyle,
      p_animation_style: normalized.animationStyle,
      p_file_path: storagePath,
      p_duration_choice: normalized.durationChoice,
      p_characters_speak: normalized.charactersSpeak,
      p_child_name: normalized.childName,
      p_original_filename: originalFilename,
    })

  if (rpcError) {
    if (fileUploaded && storagePath) {
      await supabase.storage
        .from("parent-uploads")
        .remove([storagePath])
        .catch(() => {})
    }

    const mapped = mapRequestRpcError(rpcError.message)
    return NextResponse.json(
      { error: mapped.error, code: mapped.code },
      {
        status: mapped.status,
        headers: mapped.headers,
      },
    )
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const success = toSubmissionSuccess(row)

  // The order was created and paid for, so this is not a rollback case: the
  // row simply could not be read back in a usable shape. Removing the file
  // here would strip a real order of its source, so the storage object stays.
  if (!success) {
    return NextResponse.json(
      { error: "ثبت درخواست با خطا مواجه شد. لطفاً سفارش‌های خود را بررسی کنید." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }

  return NextResponse.json(success, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}

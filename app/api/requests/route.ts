import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { createAdminSupabaseClient } from "@/lib/supabase/admin"
import { checkParentSessionLifetime } from "@/lib/auth/parent-session-lifetime"
import { createParentSessionFailureResponse } from "@/lib/auth/expired-parent-session-response"
import { parseAndValidateDraft } from "@/lib/requests/request-submission"
import { mapRequestRpcError } from "@/lib/requests/request-rpc-error"
import { toSubmissionSuccess } from "@/lib/requests/submission-response"
import { resolveCharacterId } from "@/lib/requests/resolve-character"
import { isValidSubmissionKey } from "@/lib/requests/submission-key"
import { sanitizeFileName } from "@/lib/requests/sanitize-file-name"
import { withObservability, log } from "@/lib/observability/request-context"
import { logAuthLookup } from "@/lib/observability/auth-events"
import { categorizeError } from "@/lib/observability/errors"
import {
  resolveOwnedSourceAsset,
  sourceAssetCopyName,
  PRIVATE_UPLOADS_BUCKET,
} from "@/lib/parent/gallery/source-asset"

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"]
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MiB

// Total request-body cap used to refuse an oversized POST BEFORE the multipart
// body is buffered. The file limit alone is too tight: the body also carries
// the draft JSON, the submission key, a gallery id and multipart boundaries /
// part headers, so a legitimate 10 MiB file always produces a slightly larger
// body. 256 KiB of headroom is far above that overhead (a few KiB) yet keeps
// the worst accepted buffer near 10.25 MiB. This is a fast rejection only -
// Content-Length is client-supplied, and the real file-size check below stays
// authoritative.
const MULTIPART_OVERHEAD_ALLOWANCE = 256 * 1024
const MAX_REQUEST_BODY_SIZE = MAX_FILE_SIZE + MULTIPART_OVERHEAD_ALLOWANCE

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }

export const POST = withObservability("POST /api/requests", handlePost)

// Orphan-file cleanup. Behaviour is unchanged (best effort, never throws), but a
// failed removal is now visible instead of silently leaving a stray object.
async function removeOrphanedUpload(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  path: string,
  reason: string,
): Promise<void> {
  try {
    const { error } = await supabase.storage.from("parent-uploads").remove([path])
    if (error) throw error
  } catch (error) {
    log("warn", "SUBMISSION_CLEANUP_FAILED", {
      subsystem: "storage",
      operation: "remove",
      bucket: "parent-uploads",
      reason,
      errorCode: categorizeError(error, "storage"),
    })
  }
}

async function handlePost(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "فرمت درخواست باید multipart/form-data باشد." }, { status: 415 })
  }

  // Absent Content-Length (e.g. chunked) is not rejected here; it falls through
  // to the parser and the post-parse file-size check.
  const contentLengthRaw = request.headers.get("content-length")
  if (contentLengthRaw !== null) {
    const trimmed = contentLengthRaw.trim()
    const contentLength = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    if (!Number.isSafeInteger(contentLength)) {
      log("info", "SUBMISSION_UPLOAD_REJECTED", { reason: "invalid_content_length" })
      return NextResponse.json(
        { error: "خطا در خواندن داده‌های ارسالی", code: "invalid_content_length" },
        { status: 400, headers: NO_STORE },
      )
    }
    if (contentLength > MAX_REQUEST_BODY_SIZE) {
      log("info", "SUBMISSION_UPLOAD_REJECTED", { reason: "request_too_large" })
      return NextResponse.json(
        { error: "حجم درخواست بیش از حد مجاز است. فایل کوچک‌تری انتخاب کنید.", code: "request_too_large" },
        { status: 413, headers: NO_STORE },
      )
    }
  }

  const supabase = await createServerSupabaseClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    logAuthLookup(authError)
    return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
  }

  // Keyed by the authenticated parent (never IP). Runs before the role/profile
  // lookups, the idempotency check, and above all any upload, storage copy or
  // RPC, so a limited request does no expensive work and creates no order. It
  // does not weaken idempotency: a retry that is allowed still hits the same
  // submission-key fast path / unique constraint, and a rejected one never
  // reaches them. Nothing here retries.
  const limited = await enforceRateLimit(
    user.id,
    RATE_LIMIT_POLICIES.requestSubmitBurst,
    RATE_LIMIT_POLICIES.requestSubmitHourly,
  )
  if (limited) return limited

  const { data: userRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !userRow || userRow.role !== "parent") {
    return NextResponse.json({ error: "فقط حساب‌های والد می‌توانند درخواست ثبت کنند" }, { status: 403 })
  }

  const lifetime = await checkParentSessionLifetime(supabase, user.id)
  if (!lifetime.valid) {
    return createParentSessionFailureResponse(supabase, lifetime)
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

  // The idempotency key for this logical submit attempt. Required and
  // UUID-shaped only — never free text, never derived from the draft. The
  // trusted RPC re-derives ownership from the resolved parent id below, so a
  // guessed or reused key can never retrieve another parent's order.
  const submissionKeyRaw = formData.get("submissionKey")
  if (!isValidSubmissionKey(submissionKeyRaw)) {
    return NextResponse.json({
      error: "شناسه درخواست نامعتبر است. لطفاً صفحه را دوباره بارگذاری کنید.",
      code: "invalid_submission_key",
    }, { status: 422 })
  }
  const submissionKey = submissionKeyRaw

  // ── Idempotency fast path ───────────────────────────────────────────────
  // A plain retry of an already-succeeded submission is the common case this
  // whole feature exists for. Checked before any upload or copy, so a retry
  // never re-uploads or re-copies a source file it already wrote the first
  // time. This is an optimization only — the RPC enforces the same rule
  // again, inside the transaction, guarded by the database's own unique
  // constraint, which is what actually protects concurrent duplicate
  // submissions (see 20260922100000_idempotent_order_submission.sql).
  const { data: existingOrder } = await supabase
    .from("orders")
    .select("id, type, status, candy_cost, payment_source")
    .eq("parent_id", parentProfile.id)
    .eq("submission_key", submissionKey)
    .maybeSingle()

  if (existingOrder) {
    const replayed = toSubmissionSuccess(existingOrder)
    if (replayed) {
      log("info", "SUBMISSION_REPLAYED", { orderId: replayed.orderId, replayed: true, reason: "idempotency_fast_path", paymentSource: replayed.paymentSource })
      return NextResponse.json(
        { ...replayed, replayed: true },
        { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
      )
    }
  }

  // The draft names the character; the RPC needs its id. Resolved here, before
  // anything is uploaded, so an unknown character costs no storage write.
  const character = await resolveCharacterId(supabase, normalized.characterId)
  if (!character.ok) {
    if (character.reason === "read_failed") {
      log("error", "SUBMISSION_CHARACTER_LOOKUP_FAILED", { subsystem: "database", errorCode: "DATABASE_UNAVAILABLE" })
    }
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
    log("info", "SUBMISSION_UPLOAD_REJECTED", { reason: "ambiguous_source" })
    return NextResponse.json({
      error: "برای هر درخواست فقط یک فایل مجاز است: یا بارگذاری جدید، یا انتخاب از گالری.",
      code: "ambiguous_source",
    }, { status: 422 })
  }

  if (hasUpload) {
    const uploadedFile = file as File

    if (!ALLOWED_MIME_TYPES.includes(uploadedFile.type)) {
      log("info", "SUBMISSION_UPLOAD_REJECTED", { reason: "invalid_file_type" })
      return NextResponse.json({
        error: "فرمت فایل پشتیبانی نمی‌شود. فقط JPEG، PNG و WebP مجاز هستند.",
        code: "invalid_file_type",
      }, { status: 422 })
    }

    if (uploadedFile.size > MAX_FILE_SIZE) {
      log("info", "SUBMISSION_UPLOAD_REJECTED", { reason: "file_too_large" })
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
      log("error", "SUBMISSION_STORAGE_FAILED", {
        subsystem: "storage",
        operation: "upload",
        bucket: "parent-uploads",
        mediaType: uploadedFile.type,
        errorCode: categorizeError(uploadError, "storage"),
      })
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
        log("error", "SUBMISSION_STORAGE_FAILED", {
          subsystem: "storage",
          operation: "copy",
          bucket: PRIVATE_UPLOADS_BUCKET,
          errorCode: categorizeError(copyError, "storage"),
        })
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
      p_submission_key: submissionKey,
    })

  if (rpcError) {
    if (fileUploaded && storagePath) {
      await removeOrphanedUpload(supabase, storagePath, "rpc_failed")
    }

    const mapped = mapRequestRpcError(rpcError.message)
    if (mapped.code === "INSUFFICIENT_CANDIES") {
      log("info", "SUBMISSION_INSUFFICIENT_CANDIES", { reason: mapped.code })
    } else {
      // Only our own mapped code is logged; the raw database message is not.
      log(mapped.status >= 500 ? "error" : "warn", "SUBMISSION_RPC_FAILED", {
        subsystem: "database",
        reason: mapped.code,
        errorCode: categorizeError(rpcError, "database"),
      })
    }
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
    log("error", "SUBMISSION_RESPONSE_UNREADABLE", { subsystem: "database", errorCode: "INTERNAL_ERROR" })
    return NextResponse.json(
      { error: "ثبت درخواست با خطا مواجه شد. لطفاً سفارش‌های خود را بررسی کنید." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }

  // A concurrent duplicate lost the race inside the RPC: `success.orderId` is
  // the winner's order, not `orderId` (the one generated above and used to
  // build `storagePath`). Whatever this request wrote to storage belongs to
  // no order and never will, so it is removed exactly like a rollback — the
  // same cleanup the error branch above already performs.
  if (success.replayed && fileUploaded && storagePath && success.orderId !== orderId) {
    await removeOrphanedUpload(supabase, storagePath, "replay_lost_race")
  }

  log("info", success.replayed ? "SUBMISSION_REPLAYED" : "SUBMISSION_ACCEPTED", {
    orderId: success.orderId,
    replayed: success.replayed,
    ...(success.replayed ? { reason: "idempotency_race" } : {}),
    operation: hasUpload ? "upload" : hasGalleryChoice ? "gallery_copy" : "no_file",
    // Which source paid (welcome image credit or candy). No balances, no key.
    paymentSource: success.paymentSource,
  })

  return NextResponse.json(success, {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}

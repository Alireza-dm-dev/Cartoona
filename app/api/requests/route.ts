import { NextResponse } from "next/server"
import { enforceRateLimit, RATE_LIMIT_POLICIES } from "@/lib/rate-limit"
import { createServerSupabaseClient } from "@/lib/supabase/server"
import { endParentSession } from "@/lib/auth/end-parent-session"
import { SESSION_CHECK_UNAVAILABLE_BODY } from "@/lib/auth/expired-parent-session-response"
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf"
import { verifyParentCaller } from "@/lib/parent/backend-caller"
import { fetchParentConsent, type ParentConsentFailure } from "@/lib/parent/consent/backend-consent"
import { parseAndValidateDraft } from "@/lib/requests/request-submission"
import { mapRequestRpcError } from "@/lib/requests/request-rpc-error"
import {
  createRequestViaBackend,
  lookupRequestBySubmissionKey,
  type BackendRequestCreate,
  type BackendRequestPayload,
} from "@/lib/requests/backend-request"
import type { BackendCreatedRequest } from "@/lib/requests/backend-request-response"
import type { SubmissionSuccess } from "@/lib/requests/submission-response"
import { isValidSubmissionKey } from "@/lib/requests/submission-key"
import { sanitizeFileName } from "@/lib/requests/sanitize-file-name"
import { withObservability, log } from "@/lib/observability/request-context"
import { categorizeError } from "@/lib/observability/errors"
import {
  resolveOwnedSourceAsset,
  sourceAssetCopyName,
  PRIVATE_UPLOADS_BUCKET,
} from "@/lib/parent/gallery/source-asset"

/**
 * Parent request submission (V0.1.50): the business state is PostgreSQL.
 *
 *   browser (multipart: draft, submissionKey, file | sourceAssetId)
 *   -> rejectUnsafeBrowserWrite (CSRF: multipart, Origin, Sec-Fetch-Site)
 *   -> Supabase Auth verification (verifyParentCaller; sign-in time, 30 days)
 *   -> consent read (PostgreSQL, via the backend)       cheap gate BEFORE any upload;
 *                                                       the database function re-checks it
 *   -> idempotency lookup by submission key (PostgreSQL) a retry never re-uploads
 *   -> Supabase STORAGE: upload / copy the source file  (bytes are NOT migrated)
 *   -> v3 assertion -> Fastify POST /v1/parent/requests
 *   -> create_parent_request_trusted() in PostgreSQL    order + request rows + welcome-credit-or-candy
 *                                                       spend + ledger: ONE transaction
 *
 * No Supabase Database table or RPC is read or written by the submission
 * itself. (V0.1.52: the optional gallery source is resolved in PostgreSQL via
 * the backend too - see resolveOwnedSourceAsset - so no Supabase Database read
 * remains; Supabase is Auth + Storage bytes only.) No price, credit amount, wallet, profile id, user id or role
 * is accepted from the browser: the backend derives them.
 *
 * The write is ONE attempt, never retried here. If its answer is lost the
 * route asks the backend (by submission key) whether the order exists
 * (lib/requests/backend-request.ts): found -> success; not found -> 503
 * request_not_created; could not ask -> 503 request_outcome_unknown. In both
 * 503 cases the uploaded object is KEPT (the order may exist and own it) and
 * the client retries with the SAME submission key.
 */

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
const RETRY = { ...NO_STORE, "Retry-After": "2" }

const NO_PROFILE = "پروفایل والد یافت نشد. لطفاً ابتدا رضایت خود را ثبت کنید"
const NOT_PARENT = "فقط حساب‌های والد می‌توانند درخواست ثبت کنند"
const GENERIC = "ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید."
/** Persian UX for a write whose outcome is not known: never "failed". */
const OUTCOME_UNKNOWN_MESSAGE = "نتوانستیم تأیید کنیم که درخواست ثبت شده است یا نه."
const NOT_CREATED_MESSAGE = "درخواست شما هنوز ثبت نشده است. می‌توانید دوباره تلاش کنید؛ هزینه فقط یک‌بار کسر می‌شود."
const UNAVAILABLE_MESSAGE = "ثبت درخواست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید."

/** The session / identity answers every authenticated parent route can give. */
async function authFailure(reason: ParentConsentFailure | "session_expired" | "no_parent_profile"): Promise<NextResponse> {
  switch (reason) {
    case "unauthenticated":
      return NextResponse.json({ error: "لطفاً ابتدا وارد حساب خود شوید" }, { status: 401 })
    case "session_expired":
    case "session_invalidated":
      await endParentSession()
      return NextResponse.json(
        { error: "برای ادامه دوباره وارد حساب شوید.", code: "PARENT_SESSION_EXPIRED" },
        { status: 401, headers: NO_STORE },
      )
    case "identity_not_linked":
    case "forbidden":
      return NextResponse.json({ error: NOT_PARENT }, { status: 403 })
    case "no_parent_profile":
      return NextResponse.json({ error: NO_PROFILE }, { status: 403 })
    case "auth_unavailable":
      return NextResponse.json(SESSION_CHECK_UNAVAILABLE_BODY, { status: 503, headers: RETRY })
    case "service_unavailable":
      return NextResponse.json(
        { error: UNAVAILABLE_MESSAGE, code: "request_unavailable" },
        { status: 503, headers: RETRY },
      )
  }
}

export const POST = withObservability("POST /api/requests", handlePost)

// Orphan-file cleanup. Best effort, never throws, failure is logged.
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

function successBody(order: BackendCreatedRequest): SubmissionSuccess {
  return {
    success: true,
    orderId: order.orderId,
    type: order.type,
    status: order.status,
    candyCost: order.candyCost,
    replayed: order.replayed,
    paymentSource: order.paymentSource,
  }
}

async function handlePost(request: Request) {
  const rejected = rejectUnsafeBrowserWrite(request, process.env, "multipart")
  if (rejected) return rejected

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

  // Identity: the provider verifies the session; the subject is the ONLY actor.
  const caller = await verifyParentCaller()
  if (!caller.ok) return authFailure(caller.reason)
  const { context } = caller
  const subject = context.identity.subject

  // Keyed by the authenticated parent (never IP). Runs before the consent read,
  // the idempotency check, and above all any upload, storage copy or backend
  // write, so a limited request does no expensive work and creates no order. It
  // does not weaken idempotency: a retry that is allowed still hits the same
  // submission-key lookup / unique constraint. Nothing here retries.
  const limited = await enforceRateLimit(
    subject,
    RATE_LIMIT_POLICIES.requestSubmitBurst,
    RATE_LIMIT_POLICIES.requestSubmitHourly,
  )
  if (limited) return limited

  // Consent gate: PostgreSQL, through the backend (a parent-only route, so a
  // non-parent is refused here too). It runs before any upload so an
  // unconsented parent stores nothing; create_parent_request_trusted checks it
  // again in the write transaction, so this is not the only guard.
  const consent = await fetchParentConsent(context)
  if (!consent.ok) return authFailure(consent.reason)
  if (consent.status === "no_profile") return authFailure("no_parent_profile")
  if (consent.status !== "granted") {
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
  // UUID-shaped only - never free text, never derived from the draft. The
  // database scopes it to the profile resolved from the assertion, so a
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
  // A retry of an already-succeeded submission (the common recovery case) is
  // answered before any upload or copy, so it never re-uploads a source file it
  // wrote the first time. An optimization only: the write enforces the same
  // rule again inside its transaction. If this lookup cannot be answered the
  // request simply continues to the write, which is idempotent.
  const earlier = await lookupRequestBySubmissionKey(context, submissionKey)
  if (earlier.ok && earlier.found) {
    log("info", "SUBMISSION_REPLAYED", { orderId: earlier.order.orderId, replayed: true, reason: "idempotency_fast_path", paymentSource: earlier.order.paymentSource })
    return NextResponse.json(successBody({ ...earlier.order, replayed: true }), { headers: NO_STORE })
  }
  if (!earlier.ok && earlier.reason !== "service_unavailable") return authFailure(earlier.reason)

  const supabase = await createServerSupabaseClient()
  const orderId = crypto.randomUUID()

  let storagePath: string | null = null
  let fileMimeType: string | null = null
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
    storagePath = `${subject}/${orderId}/${safeName}`
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

    // The type the object was stored with: the allow-listed value this route
    // just wrote, never a separate browser claim.
    fileMimeType = uploadedFile.type
    fileUploaded = true
  } else if (hasGalleryChoice) {
    // ── Reuse of an existing private-gallery asset ────────────────────────
    // The browser sends a media_assets id and never a storage path, so the
    // path is resolved server-side from a row that is proven to belong to
    // this parent (Supabase media metadata: the gallery is not migrated). The
    // object is then copied into the new order's own folder, which keeps the
    // <uid>/<orderId>/ storage invariant the function and the storage
    // policies both depend on.
    {
      const sourceAssetId = (sourceAssetIdRaw as string).trim()
      const resolved = await resolveOwnedSourceAsset(context, sourceAssetId)

      // A foreign id, a non-existent id and a row without a recorded MIME type
      // all answer identically, so this cannot be used to probe another
      // parent's media.
      if (!resolved.ok || !resolved.asset.mimeType || !ALLOWED_MIME_TYPES.includes(resolved.asset.mimeType)) {
        return NextResponse.json({
          error: "فایل انتخاب‌شده در دسترس نیست. لطفاً دوباره انتخاب کنید یا فایل جدیدی بارگذاری کنید.",
          code: "source_asset_unavailable",
        }, { status: 422 })
      }

      const copyName = sourceAssetCopyName(resolved.asset, sanitizeFileName)
      storagePath = `${subject}/${orderId}/${copyName}`
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

      fileMimeType = resolved.asset.mimeType
      // Marked as uploaded so a definite refusal removes the copy, not the
      // original. storagePath is the new order's own path, so cleanup can never
      // reach the source asset.
      fileUploaded = true
    }
  }

  const payload: BackendRequestPayload = {
    submissionKey,
    orderId,
    type: normalized.type,
    title: normalized.title,
    description: normalized.description || null,
    character: normalized.characterId,
    durationKey: normalized.durationKey,
    durationChoice: normalized.durationChoice,
    videoScript: normalized.videoScript,
    videoStyle: normalized.videoStyle,
    animationStyle: normalized.animationStyle,
    charactersSpeak: normalized.charactersSpeak,
    childName: normalized.childName,
    file: storagePath && fileMimeType ? { path: storagePath, mimeType: fileMimeType, originalFilename } : null,
  }

  const result: BackendRequestCreate = await createRequestViaBackend(context, payload)

  // A definite refusal created nothing, so the object this attempt stored
  // belongs to no order: remove it. An UNCERTAIN outcome never removes it - the
  // order may exist and own the object.
  const cleanupRefused = async (reason: string) => {
    if (fileUploaded && storagePath) await removeOrphanedUpload(supabase, storagePath, reason)
  }

  if (!result.ok) {
    switch (result.reason) {
      case "outcome_unknown":
        return NextResponse.json(
          { error: OUTCOME_UNKNOWN_MESSAGE, code: "request_outcome_unknown" },
          { status: 503, headers: NO_STORE },
        )
      case "not_created":
        return NextResponse.json(
          { error: NOT_CREATED_MESSAGE, code: "request_not_created" },
          { status: 503, headers: RETRY },
        )
      case "refused": {
        await cleanupRefused("write_refused")
        if (result.error === "character_unavailable") {
          return NextResponse.json(
            { error: "شخصیت انتخاب‌شده در دسترس نیست. لطفاً شخصیت دیگری انتخاب کنید.", code: "character_unavailable" },
            { status: 422 },
          )
        }
        if (result.error === "invalid_request") {
          log("error", "SUBMISSION_BACKEND_CONTRACT_VIOLATION", { subsystem: "backend", errorCode: "INTERNAL_ERROR" })
          return NextResponse.json({ error: GENERIC, code: "request_failed" }, { status: 500, headers: NO_STORE })
        }
        const mapped = mapRequestRpcError(result.error)
        if (mapped.code === "INSUFFICIENT_CANDIES") {
          log("info", "SUBMISSION_INSUFFICIENT_CANDIES", { reason: mapped.code })
        } else {
          // Only our own mapped code is logged; no database text exists here.
          log(mapped.status >= 500 ? "error" : "warn", "SUBMISSION_REFUSED", { subsystem: "backend", reason: mapped.code })
        }
        return NextResponse.json({ error: mapped.error, code: mapped.code }, { status: mapped.status, headers: mapped.headers })
      }
      case "no_parent_profile":
      case "session_expired":
      case "session_invalidated":
      case "identity_not_linked":
      case "forbidden":
      case "service_unavailable":
        await cleanupRefused(result.reason)
        return authFailure(result.reason)
      case "unavailable":
        await cleanupRefused("backend_not_configured")
        return NextResponse.json({ error: UNAVAILABLE_MESSAGE, code: "request_unavailable" }, { status: 503, headers: RETRY })
    }
  }

  const { order } = result

  // The write answered with (or the lookup found) an order that is not the one
  // this attempt built the storage key for: an earlier attempt with the same
  // submission key won. Whatever this attempt stored belongs to no order and
  // never will, so it is removed exactly like a refusal.
  if (order.orderId !== orderId) {
    await cleanupRefused("replay_lost_race")
  }

  log("info", order.replayed ? "SUBMISSION_REPLAYED" : "SUBMISSION_ACCEPTED", {
    orderId: order.orderId,
    replayed: order.replayed,
    ...(order.replayed ? { reason: "idempotency_race" } : {}),
    ...(result.confirmedBy === "lookup" ? { confirmedBy: "lookup" } : {}),
    operation: hasUpload ? "upload" : hasGalleryChoice ? "gallery_copy" : "no_file",
    // Which source paid (welcome image credit or candy). No balances, no key.
    paymentSource: order.paymentSource,
  })

  return NextResponse.json(successBody(order), { headers: NO_STORE })
}

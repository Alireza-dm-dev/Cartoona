import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  requireAdminFulfilmentAuth,
  fulfilmentJsonError,
  adminFailureResponse,
} from "@/lib/admin/requests/fulfilment-service";
import { adminRecordFinalMedia, adminUploadGate } from "@/lib/admin/requests/backend-requests";
import { uploadFinalDeliverable, removeFinalDeliverable } from "@/lib/storage/final-deliverables";
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf";
import {
  isSafeOrderId,
  validateFinalMediaFile,
  buildFinalStoragePath,
  sanitizeOriginalFilename,
  MAX_FINAL_FILES_PER_UPLOAD,
} from "@/lib/admin/requests/media-validation";
import type { FulfilmentApiErrorCode } from "@/lib/admin/requests/fulfilment-error-codes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fileError(message: string, status: number, code: FulfilmentApiErrorCode): NextResponse {
  return fulfilmentJsonError(message, status, code);
}

/**
 * POST /api/admin/requests/[requestId]/final-media
 * Multipart upload of final deliverables (V0.1.52). CSRF guard, then the
 * backend gate (admin + order + status) BEFORE any bytes are stored; files are
 * then written to the private `final-deliverables` bucket and the LINK is
 * recorded in PostgreSQL via the backend (v3). If the DB record is definitely
 * refused, the uploaded object is deleted (rollback).
 * Partial uploads are allowed: each successfully recorded file remains visible.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const csrf = rejectUnsafeBrowserWrite(request, process.env, "multipart");
  if (csrf) return csrf;

  const auth = await requireAdminFulfilmentAuth();
  if (!auth.ok) return auth.response;

  const { requestId } = await params;
  if (!isSafeOrderId(requestId)) {
    return fileError("درخواست مورد نظر یافت نشد.", 404, "REQUEST_NOT_FOUND");
  }

  // Authorize BEFORE a single byte is stored: the backend answers 403 for a
  // non-admin, 404 for an unknown order, 409 when the status refuses uploads.
  const gate = await adminUploadGate(auth.context, requestId);
  if (!gate.ok) return adminFailureResponse(gate, "بارگذاری فایل انجام نشد.");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fileError("بارگذاری فایل نامعتبر است.", 400, "REQUEST_FILE_INVALID");
  }

  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return fileError("هیچ فایلی ارسال نشده است.", 422, "REQUEST_FILE_INVALID");
  }
  if (files.length > MAX_FINAL_FILES_PER_UPLOAD) {
    return fileError(`حداکثر ${MAX_FINAL_FILES_PER_UPLOAD} فایل در هر بار ارسال مجاز است.`, 422, "REQUEST_FILE_INVALID");
  }

  const uploadedPaths: string[] = [];
  const recordedAssetPaths = new Set<string>();
  const recordedAssetIds: string[] = [];

  try {
    for (const file of files) {
      const validated = validateFinalMediaFile(file);
      if (!validated.ok) {
        return fileError(validated.error, 422, "REQUEST_FILE_INVALID");
      }

      const bytes = await file.arrayBuffer();
      const storagePath = buildFinalStoragePath(requestId, validated.mimeType, randomUUID());

      // Storage upload (bytes); a successful upload is the "object exists with this
      // MIME" fact the database contract expects the caller to have established.
      const uploaded = await uploadFinalDeliverable(storagePath, bytes, validated.mimeType);
      if (!uploaded) {
        return fileError("بارگذاری فایل انجام نشد.", 500, "REQUEST_UNKNOWN_ERROR");
      }
      uploadedPaths.push(storagePath);

      const recorded = await adminRecordFinalMedia(auth.context, requestId, {
        filePath: storagePath,
        mimeType: validated.mimeType,
        byteSize: file.size,
        originalFilename: sanitizeOriginalFilename(file.name),
      });

      if (!recorded.ok) {
        // Definite refusal -> remove the orphaned object. An UNKNOWN outcome keeps it:
        // the row may exist and own it (reload shows the truth).
        if (!(recorded.kind === "unavailable" && recorded.outcomeUnknown)) await removeFinalDeliverable(storagePath);
        return adminFailureResponse(recorded, "ثبت فایل انجام نشد.");
      }

      recordedAssetPaths.add(storagePath);
      recordedAssetIds.push(recorded.assetId);
    }

    return NextResponse.json({ data: { assetIds: recordedAssetIds } }, { status: 200 });
  } catch {
    // Unexpected failure — clean up any object that never got a DB row.
    for (const path of uploadedPaths) {
      if (!recordedAssetPaths.has(path)) {
        await removeFinalDeliverable(path);
      }
    }
    return fileError("بارگذاری فایل انجام نشد.", 500, "REQUEST_UNKNOWN_ERROR");
  }
}

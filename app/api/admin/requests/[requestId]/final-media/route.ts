import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  requireAdminFulfilmentAuth,
  fulfilmentJsonError,
  uploadFinalDeliverableToStorage,
  recordFinalMediaViaTrustedRpc,
  deleteFinalDeliverableFromStorage,
} from "@/lib/admin/requests/fulfilment-service";
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
 * Multipart upload of final deliverables. Files are first written to the
 * private `final-deliverables` bucket, then registered via the trusted RPC.
 * If the DB insert fails, the uploaded object is deleted (rollback).
 * Partial uploads are allowed: each successfully recorded file remains visible.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const auth = await requireAdminFulfilmentAuth();
  if (!auth.ok) return auth.response;

  const { requestId } = await params;
  if (!isSafeOrderId(requestId)) {
    return fileError("درخواست مورد نظر یافت نشد.", 404, "REQUEST_NOT_FOUND");
  }

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

      const upload = await uploadFinalDeliverableToStorage(requestId, storagePath, bytes, validated.mimeType);
      if (!upload.ok) {
        return fileError(upload.message, upload.status, upload.code);
      }
      uploadedPaths.push(storagePath);

      const recorded = await recordFinalMediaViaTrustedRpc(auth.adminUserId, requestId, {
        filePath: storagePath,
        mimeType: validated.mimeType,
        byteSize: file.size,
        originalFilename: sanitizeOriginalFilename(file.name),
      });

      if (!recorded.ok) {
        // DB insert failed — remove the orphaned storage object and surface the
        // mapped error (e.g. 409 when the order no longer allows uploads).
        await deleteFinalDeliverableFromStorage(storagePath);
        return fileError(recorded.message, recorded.status, recorded.code);
      }

      recordedAssetPaths.add(storagePath);
      recordedAssetIds.push(recorded.assetId);
    }

    return NextResponse.json({ data: { assetIds: recordedAssetIds } }, { status: 200 });
  } catch {
    // Unexpected failure — clean up any object that never got a DB row.
    for (const path of uploadedPaths) {
      if (!recordedAssetPaths.has(path)) {
        await deleteFinalDeliverableFromStorage(path);
      }
    }
    return fileError("بارگذاری فایل انجام نشد.", 500, "REQUEST_UNKNOWN_ERROR");
  }
}

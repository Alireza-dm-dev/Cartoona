import { NextResponse } from "next/server";
import {
  requireAdminFulfilmentAuth,
  fulfilmentJsonError,
  approveFinalMediaViaTrustedRpc,
  supersedeFinalMediaViaTrustedRpc,
} from "@/lib/admin/requests/fulfilment-service";
import { isSafeOrderId } from "@/lib/admin/requests/media-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 512;

/**
 * PATCH /api/admin/requests/[requestId]/final-media/[assetId]
 * Body: { action: "approve" | "supersede" }
 *
 * approve  → marks the asset approved + parent-visible (may unlock `ready`).
 * supersede → permanently hides the asset from parents (history kept, no delete).
 *
 * Errors: 404 asset/request not found, 409 wrong delivery state, 422 not final.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ requestId: string; assetId: string }> },
) {
  const auth = await requireAdminFulfilmentAuth();
  if (!auth.ok) return auth.response;

  const { requestId, assetId } = await params;
  if (!isSafeOrderId(requestId)) {
    return fulfilmentJsonError("درخواست مورد نظر یافت نشد.", 404, "REQUEST_NOT_FOUND");
  }
  if (!isSafeOrderId(assetId)) {
    return fulfilmentJsonError("فایل مورد نظر یافت نشد.", 404, "REQUEST_ASSET_NOT_FOUND");
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/json")) {
    return fulfilmentJsonError("فرمت درخواست باید JSON باشد.", 415, "REQUEST_INVALID_BODY");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isNaN(len) || len < 0 || len > MAX_BODY_BYTES) {
      return fulfilmentJsonError("حجم درخواست بیش از حد مجاز است.", 413, "REQUEST_INVALID_BODY");
    }
  }

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return fulfilmentJsonError("حجم درخواست بیش از حد مجاز است.", 413, "REQUEST_INVALID_BODY");
    }
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fulfilmentJsonError("فرمت JSON نامعتبر است.", 400, "REQUEST_INVALID_BODY");
  }

  const action = body.action;
  if (action !== "approve" && action !== "supersede") {
    return fulfilmentJsonError("عملیات نامعتبر است.", 422, "REQUEST_INVALID_BODY");
  }

  if (action === "approve") {
    const result = await approveFinalMediaViaTrustedRpc(auth.adminUserId, requestId, assetId);
    if (!result.ok) return fulfilmentJsonError(result.message, result.status, result.code);
    return NextResponse.json({ data: { assetId: result.assetId, deliveryStatus: "approved" } }, { status: 200 });
  }

  const result = await supersedeFinalMediaViaTrustedRpc(auth.adminUserId, requestId, assetId);
  if (!result.ok) return fulfilmentJsonError(result.message, result.status, result.code);
  return NextResponse.json({ data: { assetId: result.assetId, deliveryStatus: "superseded" } }, { status: 200 });
}

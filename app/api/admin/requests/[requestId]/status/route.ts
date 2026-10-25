import { NextResponse } from "next/server";
import {
  requireAdminFulfilmentAuth,
  fulfilmentJsonError,
  adminFailureResponse,
} from "@/lib/admin/requests/fulfilment-service";
import { adminUpdateStatus } from "@/lib/admin/requests/backend-requests";
import { rejectUnsafeBrowserWrite } from "@/lib/security/csrf";
import { isSafeOrderId } from "@/lib/admin/requests/media-validation";
import { parseAdminStatusUpdateInput } from "@/lib/admin/requests/fulfilment-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 8192;

/**
 * PATCH /api/admin/requests/[requestId]/status
 * Controlled status transition with optimistic concurrency.
 *
 * The browser only sends the desired target status + expectedUpdatedAt. The
 * transition map is enforced server-side (lib/admin/requests/workflow.ts) and
 * re-enforced atomically inside update_order_status_trusted. No new status
 * values exist; terminal statuses never reopen. A rejected status requires a
 * reason note.
 *
 * V0.1.52: PostgreSQL through the backend (v3 assertion + nonce + body digest),
 * shared CSRF guard first. A retry whose transition already committed answers
 * 200 with the current state (no second history row).
 *
 * Errors: 404 not found, 409 concurrent change / unchanged, 422 invalid
 * transition or missing reason / final media.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const csrf = rejectUnsafeBrowserWrite(request);
  if (csrf) return csrf;

  const auth = await requireAdminFulfilmentAuth();
  if (!auth.ok) return auth.response;

  const { requestId } = await params;
  if (!isSafeOrderId(requestId)) {
    return fulfilmentJsonError("درخواست مورد نظر یافت نشد.", 404, "REQUEST_NOT_FOUND");
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/json")) {
    return fulfilmentJsonError("فرمت درخواست باید JSON باشد.", 415, "REQUEST_INVALID_BODY");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isNaN(len) || len < 0) {
      return fulfilmentJsonError("درخواست نامعتبر است.", 400, "REQUEST_INVALID_BODY");
    }
    if (len > MAX_BODY_BYTES) {
      return fulfilmentJsonError("حجم درخواست بیش از حد مجاز است.", 413, "REQUEST_INVALID_BODY");
    }
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return fulfilmentJsonError("حجم درخواست بیش از حد مجاز است.", 413, "REQUEST_INVALID_BODY");
    }
    body = JSON.parse(text);
  } catch {
    return fulfilmentJsonError("فرمت JSON نامعتبر است.", 400, "REQUEST_INVALID_BODY");
  }

  const parsed = parseAdminStatusUpdateInput(body);
  if (!parsed.ok) {
    return fulfilmentJsonError(parsed.error, parsed.status, parsed.code);
  }

  // The acting admin is the verified session (v3 assertion subject); the body
  // carries none. The backend checks the admin role and the trusted function
  // re-checks it, locks the order and appends exactly one history row.
  const result = await adminUpdateStatus(auth.context, requestId, parsed.input);
  if (!result.ok) return adminFailureResponse(result, "ذخیره تغییر وضعیت انجام نشد.");

  return NextResponse.json({ data: result.result }, { status: 200 });
}

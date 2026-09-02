import { NextResponse } from "next/server";
import {
  requireAdminFulfilmentAuth,
  fulfilmentJsonError,
  updateOrderStatusViaTrustedRpc,
} from "@/lib/admin/requests/fulfilment-service";
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
 * Errors: 404 not found, 409 concurrent change / unchanged, 422 invalid
 * transition or missing reason / final media.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
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

  const result = await updateOrderStatusViaTrustedRpc(auth.adminUserId, requestId, parsed.input);
  if (!result.ok) {
    return fulfilmentJsonError(result.message, result.status, result.code);
  }

  return NextResponse.json({ data: result.result }, { status: 200 });
}

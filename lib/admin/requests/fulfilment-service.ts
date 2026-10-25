import "server-only";
import { NextResponse } from "next/server";
import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { endParentSession } from "@/lib/auth/end-parent-session";
import { verifyParentCaller } from "@/lib/parent/backend-caller";
import type { FulfilmentApiErrorCode } from "@/lib/admin/requests/fulfilment-error-codes";
import type { AdminCallFailure } from "@/lib/admin/requests/backend-requests";

/**
 * Shared answers of the admin fulfilment BFF routes (V0.1.52). The business
 * work moved to the backend (backend-requests.ts) and Storage bytes to
 * lib/storage/final-deliverables.ts; what is left here is the response shape
 * and the caller verification.
 */

export const FULFILMENT_JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function fulfilmentJsonError(
  message: string,
  status: number,
  code?: FulfilmentApiErrorCode,
): NextResponse {
  return NextResponse.json(
    code ? { error: message, code } : { error: message },
    { status, headers: FULFILMENT_JSON_HEADERS },
  );
}

/**
 * Verifies the session with the identity provider and returns the verified
 * context for backend calls. It does NOT decide the role: the backend refuses
 * a non-admin (403) on every admin route and the trusted functions re-check it
 * in PostgreSQL, so there is exactly one place that answers "is this an admin".
 * Admin routes do NOT run the parent session-lifetime check.
 */
export async function requireAdminFulfilmentAuth(): Promise<
  | { ok: true; context: VerifiedAuthContext }
  | { ok: false; response: NextResponse }
> {
  const caller = await verifyParentCaller();
  if (caller.ok) return { ok: true, context: caller.context };
  if (caller.reason === "auth_unavailable") {
    return { ok: false, response: fulfilmentJsonError("بررسی نشست موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.", 503) };
  }
  if (caller.reason === "session_expired") await endParentSession();
  return { ok: false, response: fulfilmentJsonError("لطفاً ابتدا وارد حساب خود شوید.", 401) };
}

/** The response for a backend failure of an admin call. */
export async function adminFailureResponse(failure: AdminCallFailure, unknownMessage: string): Promise<NextResponse> {
  switch (failure.kind) {
    case "auth":
      if (failure.reason === "session_expired") {
        await endParentSession();
        return fulfilmentJsonError("برای ادامه دوباره وارد حساب شوید.", 401);
      }
      if (failure.reason === "unauthenticated") return fulfilmentJsonError("لطفاً ابتدا وارد حساب خود شوید.", 401);
      return fulfilmentJsonError("شما مجوز انجام این عملیات را ندارید.", 403, "REQUEST_UNAUTHORIZED");
    case "not_found":
      return fulfilmentJsonError("درخواست مورد نظر یافت نشد.", 404, "REQUEST_NOT_FOUND");
    case "refused":
      return fulfilmentJsonError(failure.message, failure.status, failure.code);
    case "unavailable":
      // An uncertain write is NOT reported as "not saved": the client reloads to see the truth.
      return fulfilmentJsonError(
        failure.outcomeUnknown ? "نتیجه عملیات مشخص نیست. صفحه را دوباره بارگذاری کنید." : unknownMessage,
        503,
        "REQUEST_UNKNOWN_ERROR",
      );
  }
}

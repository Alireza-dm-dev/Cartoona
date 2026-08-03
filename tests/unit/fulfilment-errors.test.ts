import { describe, test, expect } from "vitest";
import { mapFulfilmentRpcError } from "@/lib/admin/requests/fulfilment-errors";

describe("fulfilment RPC error mapping", () => {
  test("maps every controlled RPC code to a safe HTTP response", () => {
    const cases: Array<[string, number, string]> = [
      ["request_admin_forbidden", 403, "REQUEST_UNAUTHORIZED"],
      ["request_forbidden", 403, "REQUEST_UNAUTHORIZED"],
      ["request_not_found", 404, "REQUEST_NOT_FOUND"],
      ["request_status_conflict", 409, "REQUEST_STATUS_CONFLICT"],
      ["request_status_unchanged", 409, "REQUEST_STATUS_UNCHANGED"],
      ["request_transition_invalid", 422, "REQUEST_TRANSITION_INVALID"],
      ["request_invalid_status", 422, "REQUEST_INVALID_STATUS"],
      ["request_final_media_required", 422, "REQUEST_FINAL_MEDIA_REQUIRED"],
      ["request_rejection_reason_required", 422, "REQUEST_REJECTION_REASON_REQUIRED"],
      ["request_note_too_long", 422, "REQUEST_NOTE_TOO_LONG"],
      ["request_upload_not_allowed", 409, "REQUEST_UPLOAD_NOT_ALLOWED"],
      ["request_invalid_path", 400, "REQUEST_FILE_INVALID"],
      ["request_file_invalid", 422, "REQUEST_FILE_INVALID"],
      ["request_file_not_found", 500, "REQUEST_FILE_INVALID"],
      ["request_asset_not_found", 404, "REQUEST_ASSET_NOT_FOUND"],
      ["request_asset_not_final", 422, "REQUEST_ASSET_NOT_FINAL"],
      ["request_asset_not_uploaded", 409, "REQUEST_ASSET_NOT_UPLOADED"],
      ["request_asset_already_superseded", 409, "REQUEST_ASSET_ALREADY_SUPERSEDED"],
    ];
    for (const [rpcCode, status, apiCode] of cases) {
      const mapped = mapFulfilmentRpcError(rpcCode);
      expect(mapped.status, rpcCode).toBe(status);
      expect(mapped.code, rpcCode).toBe(apiCode);
      expect(mapped.message.length).toBeGreaterThan(0);
    }
  });

  test("messages are Persian and never leak the raw code", () => {
    const mapped = mapFulfilmentRpcError("request_admin_forbidden");
    expect(mapped.message).not.toContain("request_admin_forbidden");
    expect(mapped.message).toMatch(/[\u0600-\u06FF]/);
  });

  test("unknown and non-string codes fall back to a generic 500", () => {
    for (const raw of ["something_strange", "auth/invalid-login", undefined, null, 42, { x: 1 }]) {
      const mapped = mapFulfilmentRpcError(raw);
      expect(mapped.status).toBe(500);
      expect(mapped.code).toBe("REQUEST_UNKNOWN_ERROR");
      expect(mapped.message).toBe("خطای داخلی سرور رخ داد.");
    }
  });
});

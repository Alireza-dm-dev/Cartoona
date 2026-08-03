import type { ParentSessionPolicyResult } from "@/types/database";

export const PARENT_SESSION_MAX_DAYS = 30;

export type ParentSessionLifetimeResult =
  | {
      valid: true;
      sessionStartedAt: string;
      expiresAt: string;
    }
  | {
      valid: false;
      reason: "expired" | "missing_session" | "lookup_failed";
    };

interface SessionPolicyClient {
  rpc(
    fn: "get_current_parent_session_policy",
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function isValidPolicyRow(
  row: unknown,
): row is ParentSessionPolicyResult {
  if (row === null || typeof row !== "object") return false;
  if (
    !("is_valid" in row) ||
    !("session_started_at" in row) ||
    !("expires_at" in row)
  ) {
    return false;
  }

  const r = row as {
    is_valid: unknown;
    session_started_at: unknown;
    expires_at: unknown;
  };

  if (typeof r.is_valid !== "boolean") return false;
  if (r.session_started_at !== null && typeof r.session_started_at !== "string") return false;
  if (r.expires_at !== null && typeof r.expires_at !== "string") return false;

  return true;
}

export async function checkCurrentParentSessionLifetime(
  supabase: SessionPolicyClient,
): Promise<ParentSessionLifetimeResult> {
  const { data, error } = await supabase.rpc(
    "get_current_parent_session_policy",
  );

  if (error) {
    return { valid: false, reason: "lookup_failed" };
  }

  if (!Array.isArray(data) || data.length !== 1) {
    return { valid: false, reason: "lookup_failed" };
  }

  const row = data[0];
  if (!isValidPolicyRow(row)) {
    return { valid: false, reason: "lookup_failed" };
  }

  if (row.is_valid) {
    if (
      typeof row.session_started_at !== "string" ||
      typeof row.expires_at !== "string"
    ) {
      return { valid: false, reason: "lookup_failed" };
    }

    const started = Date.parse(row.session_started_at);
    const expires = Date.parse(row.expires_at);

    if (isNaN(started) || isNaN(expires) || expires <= started) {
      return { valid: false, reason: "lookup_failed" };
    }

    return {
      valid: true,
      sessionStartedAt: row.session_started_at,
      expiresAt: row.expires_at,
    };
  }

  if (row.session_started_at === null && row.expires_at === null) {
    return { valid: false, reason: "missing_session" };
  }

  return { valid: false, reason: "expired" };
}

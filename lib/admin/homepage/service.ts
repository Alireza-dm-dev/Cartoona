import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isAdminRole } from "@/lib/auth/admin-role";
import { HOMEPAGE_SINGLETON_KEY, type HomepageContent } from "@/lib/homepage/types";
import { DEFAULT_HOMEPAGE_CONTENT } from "@/lib/homepage/default-content";
import { validateHomepageContent } from "@/lib/homepage/validation";
import { normalizeHomepageContent } from "@/lib/homepage/content-resolution";
import { mapAdminHomepageRpcError } from "@/lib/admin/homepage/errors";
import type { ParsedHomepagePutBody } from "@/lib/admin/homepage/put-validation";
import type {
  AdminHomepageGetResponse,
  AdminHomepagePutSuccess,
} from "@/lib/admin/homepage/types";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function homepageJsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: JSON_HEADERS });
}

export function homepageJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: JSON_HEADERS });
}

/**
 * Authenticates the request as an admin / super_admin and returns the verified
 * server supabase client plus the user id. On failure returns a NextResponse
 * and null. Admin routes do NOT run the parent session-lifetime check.
 */
export async function requireAdminHomepageAuth(): Promise<
  | { ok: true; supabase: SupabaseClient; adminUserId: string }
  | { ok: false; response: NextResponse }
> {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return { ok: false, response: homepageJsonError("خطای احراز هویت رخ داد.", 500) };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: homepageJsonError("لطفاً ابتدا وارد حساب خود شوید.", 401) };
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (roleError || !roleRow || !isAdminRole(roleRow.role)) {
    return { ok: false, response: homepageJsonError("شما مجوز انجام این عملیات را ندارید.", 403) };
  }

  return { ok: true, supabase, adminUserId: user.id };
}

/**
 * Reads the homepage singleton for the admin editor. Never throws: when the
 * CMS tables are absent (production before the pending migrations are
 * applied), the read fails, or the row is missing/invalid, the editor starts
 * from the bundled defaults with revision null — the same fallback the public
 * read path uses. A null revision disables save (the editor reports that the
 * CMS tables are not available yet instead of attempting a write).
 */
export async function queryAdminHomepageContent(
  supabase: SupabaseClient,
): Promise<AdminHomepageGetResponse> {
  try {
    const { data, error } = await supabase
      .from("homepage_content")
      .select("content_json, revision")
      .eq("singleton_key", HOMEPAGE_SINGLETON_KEY)
      .maybeSingle();

    if (error || !data) {
      return { content: DEFAULT_HOMEPAGE_CONTENT, revision: null, isDefault: true, source: "default" };
    }

    // Normalize before validating, exactly as the public read path does.
    // A row seeded before a newer CMS version exists is valid content that
    // simply predates a section (the Phase-1 seed predates `navigation`);
    // rejecting it here would strand the editor in degraded mode with no way
    // out, since only a save can add the missing section.
    const validated = validateHomepageContent(normalizeHomepageContent(data.content_json));
    if (!validated.ok) {
      // Stored content is genuinely malformed, not merely older. Distinguish it
      // from "tables/row absent" in the server log — field paths only, never
      // stored values.
      console.warn(
        "[admin/homepage] stored content failed validation after normalization; serving defaults",
        { fields: validated.errors.slice(0, 20).map((e) => e.field) },
      );
      return { content: DEFAULT_HOMEPAGE_CONTENT, revision: null, isDefault: true, source: "default" };
    }

    return {
      content: validated.content,
      revision: typeof data.revision === "number" ? data.revision : null,
      isDefault: false,
      source: "database",
    };
  } catch {
    return { content: DEFAULT_HOMEPAGE_CONTENT, revision: null, isDefault: true, source: "default" };
  }
}

/**
 * Turns a pure PUT-body parse result into a ready-to-send error response.
 * Success is unwrapped by the caller.
 */
export function putBodyErrorResponse(
  parsed: Extract<ParsedHomepagePutBody, { ok: false }>,
): NextResponse {
  if (parsed.status === 422) {
    return homepageJson({ error: parsed.error, code: parsed.code, errors: parsed.errors }, 422);
  }
  return homepageJsonError(parsed.error, parsed.status);
}

export type UpdateHomepageResult =
  | { ok: true; saved: AdminHomepagePutSuccess }
  | { ok: false; code: "HOMEPAGE_CONFLICT"; message: string; status: 409 }
  | { ok: false; code: Exclude<string, "HOMEPAGE_CONFLICT">; message: string; status: number };

/**
 * Writes validated homepage content via the trusted service-role RPC. The
 * browser never touches the homepage tables directly (RLS SELECT-only). The
 * RPC re-verifies the admin role server-side and enforces optimistic
 * concurrency — a stale revision surfaces as HOMEPAGE_CONFLICT so the caller
 * can re-read and offer reload-on-conflict.
 */
export async function updateHomepageViaTrustedRpc(
  adminUserId: string,
  content: HomepageContent,
  expectedRevision: number,
): Promise<UpdateHomepageResult> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, code: "HOMEPAGE_UNKNOWN_ERROR", message: "ذخیره تغییرات انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("update_homepage_content_trusted", {
    p_admin_user_id: adminUserId,
    p_content_json: content,
    p_expected_revision: expectedRevision,
  });

  if (error) {
    const mapped = mapAdminHomepageRpcError(error.message);
    if (mapped.code === "HOMEPAGE_CONFLICT") {
      return { ok: false, code: "HOMEPAGE_CONFLICT", message: mapped.message, status: 409 };
    }
    return { ok: false, code: mapped.code, message: mapped.message, status: mapped.status };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row || typeof row.revision !== "number") {
    return { ok: false, code: "HOMEPAGE_UNKNOWN_ERROR", message: "ذخیره تغییرات انجام نشد.", status: 500 };
  }
  const revision: number = row.revision;

  // Same normalization contract as the read path: the row echoed back by the
  // RPC is stored content and is read through the identical lens.
  const validated = validateHomepageContent(
    normalizeHomepageContent(row.content_json ?? content),
  );
  const savedContent = validated.ok ? validated.content : content;

  return {
    ok: true,
    saved: {
      content: savedContent,
      revision,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date().toISOString(),
    },
  };
}

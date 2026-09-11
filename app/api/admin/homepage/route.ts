import {
  homepageJson,
  homepageJsonError,
  putBodyErrorResponse,
  queryAdminHomepageContent,
  requireAdminHomepageAuth,
  updateHomepageViaTrustedRpc,
} from "@/lib/admin/homepage/service";
import { parseAdminHomepagePutBody } from "@/lib/admin/homepage/put-validation";
import type { AdminHomepageConflict } from "@/lib/admin/homepage/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * GET /api/admin/homepage
 * Returns the current homepage content with its revision for the admin
 * editor. Falls back to bundled defaults (revision null) when the CMS row or
 * tables are absent — e.g. production before the pending migrations are
 * applied. A null revision tells the editor that saving is unavailable.
 */
export async function GET() {
  const auth = await requireAdminHomepageAuth();
  if (!auth.ok) return auth.response;

  const result = await queryAdminHomepageContent(auth.supabase);
  return homepageJson(result);
}

/**
 * PUT /api/admin/homepage
 * Saves the full homepage document through the trusted service-role RPC.
 * Body: { content: HomepageContent, expectedRevision: number }.
 * 422 on contract violations (with per-field errors), 409 with the current
 * server snapshot on revision conflict.
 */
export async function PUT(request: Request) {
  const auth = await requireAdminHomepageAuth();
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/json")) {
    return homepageJsonError("فرمت درخواست باید JSON باشد.", 415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (isNaN(len) || len < 0) return homepageJsonError("درخواست نامعتبر است.", 400);
    if (len > MAX_BODY_BYTES) {
      return homepageJsonError("حجم درخواست بیش از حد مجاز است.", 413);
    }
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return homepageJsonError("حجم درخواست بیش از حد مجاز است.", 413);
    }
    body = JSON.parse(text);
  } catch {
    return homepageJsonError("فرمت JSON نامعتبر است.", 400);
  }

  const parsed = parseAdminHomepagePutBody(body);
  if (!parsed.ok) return putBodyErrorResponse(parsed);

  // Refuse to write when the editor never loaded a real revision (CMS tables
  // absent or row missing/invalid). Writing blind would risk clobbering.
  if (parsed.expectedRevision < 1) {
    return homepageJsonError("نسخه مورد انتظار نامعتبر است. صفحه را دوباره بارگذاری کنید.", 400);
  }

  const result = await updateHomepageViaTrustedRpc(
    auth.adminUserId,
    parsed.content,
    parsed.expectedRevision,
  );

  if (!result.ok) {
    if (result.code === "HOMEPAGE_CONFLICT") {
      // Re-read the current snapshot so the editor can reload-on-conflict.
      const current = await queryAdminHomepageContent(auth.supabase);
      const conflict: AdminHomepageConflict = {
        error: result.message,
        code: "HOMEPAGE_CONFLICT",
        content: current.content,
        revision: current.revision ?? parsed.expectedRevision,
      };
      return homepageJson(conflict, 409);
    }
    return homepageJsonError(result.message, result.status);
  }

  return homepageJson(result.saved);
}

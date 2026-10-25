import "server-only";
import { NextResponse } from "next/server";
import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { endParentSession } from "@/lib/auth/end-parent-session";
import { callGet } from "@/lib/backend/call";
import { verifiedCaller } from "@/lib/http/backend-route-responses";
import { saveHomepageContent, type HomepageWireData } from "@/lib/homepage/backend-homepage";
import { type HomepageContent } from "@/lib/homepage/types";
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
 * Verifies the session with the identity provider (V0.1.53). The ADMIN decision
 * is made by the backend (GET /v1/admin/cms/gate -> 403 for a non-admin) BEFORE
 * a body is parsed or a byte stored, never from a Supabase table; the trusted
 * functions re-check the role in PostgreSQL on every write. Admin routes do NOT run the parent
 * session-lifetime check.
 */
export async function requireAdminHomepageAuth(): Promise<
  | { ok: true; context: VerifiedAuthContext }
  | { ok: false; response: NextResponse }
> {
  const caller = await verifiedCaller();
  if (!caller.ok) {
    // Same JSON shape the homepage UI already understands.
    const body = (await caller.response.clone().json().catch(() => ({}))) as { error?: string };
    return { ok: false, response: homepageJsonError(body.error ?? "لطفاً ابتدا وارد حساب خود شوید.", caller.response.status) };
  }
  // The ADMIN decision, before any body is parsed or any byte stored (PostgreSQL role, via the backend).
  const denied = await requireCmsAdmin(caller.context);
  if (denied) return { ok: false, response: denied };
  return { ok: true, context: caller.context };
}

/** Admin-only gate asked before any CMS object is stored (nothing is written by it). */
export async function requireCmsAdmin(context: VerifiedAuthContext): Promise<NextResponse | null> {
  const r = await callGet(context, "cms_gate", "/v1/admin/cms/gate");
  if (r.ok) return null;
  if (r.kind === "auth") {
    if (r.reason === "session_expired" || r.reason === "session_invalidated") {
      await endParentSession();
      return homepageJsonError("برای ادامه دوباره وارد حساب خود شوید.", 401);
    }
    if (r.reason === "unauthenticated") return homepageJsonError("لطفاً ابتدا وارد حساب خود شوید.", 401);
    return homepageJsonError("شما مجوز انجام این عملیات را ندارید.", 403);
  }
  return homepageJsonError("عملیات انجام نشد. لطفاً دوباره تلاش کنید.", 503);
}

/**
 * Builds the editor's initial state from the backend payload (null = the
 * backend could not answer). Never throws: when the CMS row is absent, invalid
 * or unreadable, the editor starts from the bundled defaults with revision null
 * - the same fallback the public read path uses. A null revision disables save
 * (the editor reports that the CMS is not available instead of writing blind).
 */
export function adminHomepageContentFromData(data: HomepageWireData | null): AdminHomepageGetResponse {
  try {
    if (!data || !data.content) {
      return { content: DEFAULT_HOMEPAGE_CONTENT, revision: null, isDefault: true, source: "default" };
    }

    // Normalize before validating, exactly as the public read path does.
    // A row seeded before a newer CMS version exists is valid content that
    // simply predates a section (the Phase-1 seed predates `navigation`);
    // rejecting it here would strand the editor in degraded mode with no way
    // out, since only a save can add the missing section.
    const validated = validateHomepageContent(normalizeHomepageContent(data.content.contentJson));
    if (!validated.ok) {
      // Stored content is genuinely malformed, not merely older. Distinguish it
      // from "row absent" in the server log - field paths only, never stored values.
      console.warn(
        "[admin/homepage] stored content failed validation after normalization; serving defaults",
        { fields: validated.errors.slice(0, 20).map((e) => e.field) },
      );
      return { content: DEFAULT_HOMEPAGE_CONTENT, revision: null, isDefault: true, source: "default" };
    }

    return {
      content: validated.content,
      revision: typeof data.content.revision === "number" ? data.content.revision : null,
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
 * Writes validated homepage content through the backend (v3 assertion for the
 * verified admin; the trusted function re-verifies the role and enforces
 * optimistic concurrency - a stale revision surfaces as HOMEPAGE_CONFLICT so the
 * caller can re-read and offer reload-on-conflict). An unavailable backend is
 * reported as "result unknown": the write may have committed.
 */
export async function updateHomepageViaBackend(
  context: VerifiedAuthContext,
  content: HomepageContent,
  expectedRevision: number,
): Promise<UpdateHomepageResult> {
  const out = await saveHomepageContent(context, content, expectedRevision);
  if (!out.ok) {
    if ("refusal" in out) {
      const mapped = mapAdminHomepageRpcError(out.refusal.token);
      if (mapped.code === "HOMEPAGE_CONFLICT") {
        return { ok: false, code: "HOMEPAGE_CONFLICT", message: mapped.message, status: 409 };
      }
      return { ok: false, code: mapped.code, message: mapped.message, status: mapped.status };
    }
    const f = out.failure;
    if (f.kind === "auth") {
      return f.reason === "session_expired" || f.reason === "session_invalidated"
        ? { ok: false, code: "UNAUTHENTICATED", message: "برای ادامه دوباره وارد حساب خود شوید.", status: 401 }
        : { ok: false, code: "HOMEPAGE_FORBIDDEN", message: "شما مجوز انجام این عملیات را ندارید.", status: 403 };
    }
    return {
      ok: false,
      code: "HOMEPAGE_UNKNOWN_ERROR",
      message: f.outcomeUnknown ? "نتیجه ذخیره مشخص نیست. صفحه را دوباره بارگذاری کنید." : "ذخیره تغییرات انجام نشد.",
      status: 503,
    };
  }

  const row = out.value;
  // Same normalization contract as the read path: the row echoed back is
  // stored content and is read through the identical lens.
  const validated = validateHomepageContent(normalizeHomepageContent(row.contentJson ?? content));
  const savedContent = validated.ok ? validated.content : content;

  return {
    ok: true,
    saved: {
      content: savedContent,
      revision: row.revision,
      updatedAt: row.updatedAt || new Date().toISOString(),
    },
  };
}

import type { HomepageContent } from "@/lib/homepage/types";
import { validateHomepageContent, type HomepageValidationError } from "@/lib/homepage/validation";

/**
 * Pure PUT-body parsing for the admin homepage write route. No IO, no
 * NextResponse — returns a discriminated result the route turns into HTTP.
 * Unit-tested directly.
 */

export interface ValidHomepagePutBody {
  ok: true;
  content: HomepageContent;
  expectedRevision: number;
}

export interface InvalidHomepagePutBody {
  ok: false;
  status: number;
  error: string;
  code?: "HOMEPAGE_INVALID";
  errors?: HomepageValidationError[];
}

export type ParsedHomepagePutBody = ValidHomepagePutBody | InvalidHomepagePutBody;

/**
 * Parses and validates a PUT body: pure shape checks (object with content +
 * integer expectedRevision ≥ 1) followed by full contract validation.
 */
export function parseAdminHomepagePutBody(body: unknown): ParsedHomepagePutBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "درخواست نامعتبر است." };
  }

  const { content, expectedRevision } = body as { content: unknown; expectedRevision: unknown };

  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return {
      ok: false,
      status: 400,
      error: "نسخه مورد انتظار نامعتبر است. صفحه را دوباره بارگذاری کنید.",
    };
  }

  const validated = validateHomepageContent(content);
  if (!validated.ok) {
    return {
      ok: false,
      status: 422,
      error: "محتوای ارسال‌شده معتبر نیست.",
      code: "HOMEPAGE_INVALID",
      errors: validated.errors,
    };
  }

  return { ok: true, content: validated.content, expectedRevision };
}

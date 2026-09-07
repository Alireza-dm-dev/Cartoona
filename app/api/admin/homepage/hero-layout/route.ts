import {
  mediaJson,
  mediaJsonError,
  requireAdminHomepageAuth,
  updateHeroLayout,
} from "@/lib/admin/homepage/media-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * PUT /api/admin/homepage/hero-layout — standalone TV rect calibration edit
 * (no media change). Body: { x, y, width, height, expectedRevision }.
 * Normalized fractions only; optimistic concurrency required.
 */
export async function PUT(request: Request) {
  const auth = await requireAdminHomepageAuth();
  if (!auth.ok) return auth.response;

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/json")) {
    return mediaJsonError("فرمت درخواست باید JSON باشد.", 415);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return mediaJsonError("حجم درخواست بیش از حد مجاز است.", 413);
    }
    body = JSON.parse(text);
  } catch {
    return mediaJsonError("فرمت JSON نامعتبر است.", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return mediaJsonError("درخواست نامعتبر است.", 400);
  }
  const { x, y, width, height, expectedRevision } = body as Record<string, unknown>;

  const result = await updateHeroLayout(auth.adminUserId, { x, y, width, height }, expectedRevision);
  if (!result.ok) {
    if (result.code === "HOMEPAGE_LAYOUT_CONFLICT") {
      return mediaJson({ error: result.message, code: result.code }, 409);
    }
    const status = result.status === 409 ? 409 : result.status === 400 ? 400 : result.status === 403 ? 403 : 422;
    return mediaJson({ error: result.message, code: result.code }, status as 400 | 403 | 422 | 409);
  }

  return mediaJson({ rect: result.rect, revision: result.revision });
}

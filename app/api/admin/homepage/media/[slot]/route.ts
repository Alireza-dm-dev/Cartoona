import { isHomepageMediaSlot, type HomepageMediaSlot } from "@/lib/homepage/media-slots";
import {
  deleteHomepageMedia,
  mediaJson,
  mediaJsonError,
  replaceHomepageMedia,
  requireAdminHomepageAuth,
} from "@/lib/admin/homepage/media-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_MULTIPART_BYTES = 52 * 1024 * 1024;

function checkSlot(raw: string): HomepageMediaSlot | null {
  return isHomepageMediaSlot(raw) ? raw : null;
}

/**
 * POST /api/admin/homepage/media/[slot] — multipart/form-data.
 * Fields: file (required), tv_rect (JSON, required for hero.background,
 * rejected elsewhere), applyToSections ("true", hero only), confirmPreview
 * ("true", required for independent sections.background replacement).
 *
 * Flow: validate → upload new object → ONE atomic RPC → cleanup.
 * Unknown slots are rejected before any file is read.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slot: string }> },
) {
  const { slot: rawSlot } = await params;
  const slot = checkSlot(decodeURIComponent(rawSlot));
  if (!slot) {
    return mediaJsonError("جایگاه رسانه نامعتبر است.", 400);
  }

  const auth = await requireAdminHomepageAuth();
  if (!auth.ok) return auth.response;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (isNaN(len) || len < 0) return mediaJsonError("درخواست نامعتبر است.", 400);
    if (len > MAX_MULTIPART_BYTES) return mediaJsonError("حجم درخواست بیش از حد مجاز است.", 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return mediaJsonError("فرمت فرم نامعتبر است.", 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return mediaJsonError("فایلی ارسال نشده است.", 422);
  }
  if (file.size > MAX_MULTIPART_BYTES) {
    return mediaJsonError("حجم درخواست بیش از حد مجاز است.", 413);
  }

  let tvRect: unknown = null;
  const tvRectRaw = formData.get("tv_rect");
  if (typeof tvRectRaw === "string" && tvRectRaw.trim() !== "") {
    try {
      tvRect = JSON.parse(tvRectRaw);
    } catch {
      return mediaJsonError("مختصات موقعیت تلویزیون نامعتبر است.", 422);
    }
  }

  const applyToSections = formData.get("apply_to_sections") === "true";
  const confirmPreview = formData.get("confirm_preview") === "true";

  let layoutRevision: number | null = null;
  const layoutRevisionRaw = formData.get("expected_layout_revision");
  if (typeof layoutRevisionRaw === "string" && layoutRevisionRaw.trim() !== "") {
    const n = Number(layoutRevisionRaw);
    if (Number.isInteger(n) && n >= 1) layoutRevision = n;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return mediaJsonError("خواندن فایل انجام نشد.", 422);
  }

  const result = await replaceHomepageMedia({
    adminUserId: auth.adminUserId,
    slot,
    fileBytes: bytes,
    fileName: file.name,
    claimedMime: file.type,
    tvRect,
    applyToSections,
    confirmPreview,
    expectedLayoutRevision: layoutRevision,
  });

  if (!result.ok) {
    if (result.code === "HOMEPAGE_LAYOUT_CONFLICT") {
      return mediaJson({ error: result.message, code: result.code }, 409);
    }
    return mediaJson(
      { error: result.message, code: result.code },
      result.status as 400 | 403 | 413 | 422 | 500,
    );
  }

  return mediaJson({
    record: result.record,
    sectionsRecord: result.sectionsRecord,
    layout: result.layout,
  });
}

/**
 * DELETE /api/admin/homepage/media/[slot] — revert to local-asset fallback.
 * Metadata removal goes through the trusted RPC; the storage object is
 * deleted only after that succeeds. Always safe: the public homepage renders
 * committed local assets until Phase 4.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slot: string }> },
) {
  const { slot: rawSlot } = await params;
  const slot = checkSlot(decodeURIComponent(rawSlot));
  if (!slot) {
    return mediaJsonError("جایگاه رسانه نامعتبر است.", 400);
  }

  const auth = await requireAdminHomepageAuth();
  if (!auth.ok) return auth.response;

  const result = await deleteHomepageMedia(auth.adminUserId, slot);
  if (!result.ok) {
    return mediaJsonError(result.message, result.status);
  }
  return mediaJson({ slotKey: slot, reverted: true });
}

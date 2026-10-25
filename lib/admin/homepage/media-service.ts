import "server-only";
import { NextResponse } from "next/server";
import type { VerifiedAuthContext } from "@/lib/auth/supabase-identity-adapter";
import { type HomepageMediaSlot } from "@/lib/homepage/media-slots";
import { validateHeroTvRect, type HeroTvRect } from "@/lib/homepage/hero-layout";
import {
  buildMediaStoragePath,
  decideMediaRollback,
  toSafeSlotRecord,
  validateUploadCandidate,
  type MediaRowSnapshot,
  type SafeSlotRecord,
} from "@/lib/admin/homepage/media-validation";
import { buildMediaOverview, type AdminMediaOverview } from "@/lib/admin/homepage/media-overview";
import { mapAdminHomepageMediaRpcError } from "@/lib/admin/homepage/media-errors";
import { requireAdminHomepageAuth, requireCmsAdmin } from "@/lib/admin/homepage/service";
import {
  fetchHomepageData,
  recordHomepageMedia,
  revertHomepageMedia,
  saveHeroLayout,
  type HomepageWireData,
  type WriteOutcome,
} from "@/lib/homepage/backend-homepage";
import { homepageMediaPublicUrl, removeHomepageMedia, uploadHomepageMedia } from "@/lib/storage/homepage-media";

export type { AdminMediaOverview, AdminMediaSlotView } from "@/lib/admin/homepage/media-overview";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function mediaJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: JSON_HEADERS });
}

export function mediaJsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: JSON_HEADERS });
}

/**
 * The media overview for the admin manager, built from the backend payload
 * (V0.1.53: PostgreSQL; null = the backend could not answer). Never throws:
 * missing rows degrade to local-asset fallback views (previewUrl = committed
 * /public path, metadata nulls). Storage is touched only to build public URLs.
 */
export function queryAdminHomepageMedia(data: HomepageWireData | null): AdminMediaOverview {
  return buildMediaOverview(data?.media ?? [], data?.heroLayout ?? null, homepageMediaPublicUrl);
}

/** A write that failed for a reason other than a business refusal. */
function failureOf(out: Exclude<WriteOutcome<unknown>, { ok: true }>): { message: string; status: number; code: string; unknown: boolean } {
  if ("refusal" in out) {
    const mapped = mapAdminHomepageMediaRpcError(out.refusal.token);
    return { message: mapped.message, status: mapped.code === "HOMEPAGE_LAYOUT_CONFLICT" ? 409 : mapped.status, code: mapped.code, unknown: false };
  }
  const f = out.failure;
  if (f.kind === "auth") {
    return f.reason === "session_expired" || f.reason === "session_invalidated"
      ? { message: "برای ادامه دوباره وارد حساب خود شوید.", status: 401, code: "UNAUTHENTICATED", unknown: false }
      : { message: "شما مجوز انجام این عملیات را ندارید.", status: 403, code: "HOMEPAGE_FORBIDDEN", unknown: false };
  }
  return {
    message: f.outcomeUnknown ? "نتیجه عملیات مشخص نیست. صفحه را دوباره بارگذاری کنید." : "عملیات رسانه انجام نشد.",
    status: 503,
    code: "HOMEPAGE_UNKNOWN_ERROR",
    unknown: f.outcomeUnknown,
  };
}

export type ReplaceMediaResult =
  | { ok: true; record: SafeSlotRecord; sectionsRecord: SafeSlotRecord | null; layout: { rect: HeroTvRect; revision: number } | null }
  | { ok: false; message: string; status: number; code: string };

interface ReplaceMediaInput {
  context: VerifiedAuthContext;
  slot: HomepageMediaSlot;
  fileBytes: Uint8Array;
  fileName: string;
  claimedMime: string;
  tvRect: unknown; // required for hero.background; must be absent otherwise
  applyToSections: boolean; // only meaningful for hero.background
  confirmPreview: boolean; // required for independent sections.background replacement
  expectedLayoutRevision: number | null;
}

/**
 * Full replacement flow with the Correction-1 shape:
 *   validate → upload new object → ONE atomic RPC → cleanup.
 * Old objects are deleted only after DB success; a failed commit deletes the
 * newly uploaded object instead. No multi-RPC partial path exists.
 */
export async function replaceHomepageMedia(input: ReplaceMediaInput): Promise<ReplaceMediaResult> {
  const fail = (message: string, status: number, code: string): ReplaceMediaResult => ({
    ok: false, message, status, code,
  });

  // ── slot-scoped field gates (before storage) ──
  if (input.slot === "hero.background") {
    if (validateHeroTvRect(input.tvRect).length > 0) {
      return fail(
        "برای فعال‌سازی پس‌زمینه جدید هیرو، ابتدا موقعیت ویدیوی تلویزیون را روی تصویر تنظیم و تأیید کنید.",
        422, "HOMEPAGE_MEDIA_GEOMETRY_REQUIRED",
      );
    }
    if (typeof input.expectedLayoutRevision !== "number") {
      return fail("نسخه چیدمان نامعتبر است. صفحه را دوباره بارگذاری کنید.", 400, "HOMEPAGE_LAYOUT_CONFLICT");
    }
  } else if (input.tvRect !== null && input.tvRect !== undefined) {
    return fail("مختصات تلویزیون فقط برای پس‌زمینه هیرو پذیرفته می‌شود.", 400, "HOMEPAGE_MEDIA_BAD_FILE");
  }
  if (input.applyToSections && input.slot !== "hero.background") {
    return fail("درخواست نامعتبر است.", 400, "HOMEPAGE_MEDIA_BAD_SLOT");
  }
  if (input.slot === "sections.background" && !input.applyToSections && !input.confirmPreview) {
    return fail("پیش‌نمایش پس‌زمینه بخش‌ها را تأیید کنید. تصویر فعلی بخش پایینی (~۶۳٪) برش می‌خورد.", 422, "HOMEPAGE_MEDIA_BAD_FILE");
  }

  // ── file validation (MIME + magic bytes + caps + probed dims) ──
  const checked = validateUploadCandidate({
    slot: input.slot,
    claimedMime: input.claimedMime,
    byteSize: input.fileBytes.byteLength,
    headBytes: input.fileBytes.slice(0, 32),
    fullBytesForProbe: input.fileBytes,
  });
  if (!checked.ok) {
    const tooLarge = checked.errors.some((e) => e.message.includes("exceeds"));
    return fail(
      checked.errors[0]?.message ?? "فایل معتبر نیست.",
      tooLarge ? 413 : 422,
      tooLarge ? "HOMEPAGE_MEDIA_TOO_LARGE" : "HOMEPAGE_MEDIA_BAD_FILE",
    );
  }
  void input.fileName; // original filename never influences the storage path
  const { mediaType, mime, byteSize, width, height } = checked.validated;

  // ── admin gate BEFORE any byte is stored (backend: 403 for a non-admin) ──
  const denied = await requireCmsAdmin(input.context);
  if (denied) {
    const body = (await denied.json().catch(() => ({}))) as { error?: string };
    return fail(body.error ?? "عملیات رسانه انجام نشد.", denied.status, denied.status === 403 ? "HOMEPAGE_FORBIDDEN" : "HOMEPAGE_UNKNOWN_ERROR");
  }

  // ── old snapshot (for post-success cleanup only) ──
  const before = await fetchHomepageData();
  if (before === null) return fail("عملیات رسانه انجام نشد.", 503, "HOMEPAGE_UNKNOWN_ERROR");
  let oldPrimaryPath: string | null = null;
  let oldSectionsPath: string | null = null;
  for (const r of before.media) {
    if (r.slotKey === input.slot) oldPrimaryPath = r.storagePath;
    if (input.applyToSections && r.slotKey === "sections.background") oldSectionsPath = r.storagePath;
  }

  // ── upload new object (server-generated path) ──
  const storagePath = buildMediaStoragePath(
    input.slot, mime, Date.now(), crypto.randomUUID(),
  );
  const uploaded = await uploadHomepageMedia(storagePath, input.fileBytes.slice(), mime);
  if (!uploaded) {
    return fail("بارگذاری فایل انجام نشد.", 500, "HOMEPAGE_UNKNOWN_ERROR");
  }

  // ── ONE atomic commit (PostgreSQL, through the backend) ──
  const out = await recordHomepageMedia(input.context, {
    slot: input.slot,
    mediaType,
    storagePath,
    mimeType: mime,
    byteSize,
    width,
    height,
    tvRect: input.slot === "hero.background" ? (input.tvRect as HeroTvRect) : null,
    expectedLayoutRevision: input.expectedLayoutRevision,
    applyToSections: input.applyToSections,
  });

  if (!out.ok) {
    const f = failureOf(out);
    // A definite refusal: previous state intact - remove the orphan object.
    // An UNKNOWN outcome keeps it: the row may have committed and be live.
    if (!f.unknown) {
      for (const action of decideMediaRollback({ newObjectUploaded: true, dbCommitted: false, oldObjectSuperseded: false })) {
        if (action === "delete-new-object") await removeHomepageMedia([storagePath]);
      }
    }
    return fail(f.message, f.status, f.code);
  }

  // ── post-success cleanup: superseded objects only, best-effort ──
  const committed = out.value as { media: MediaRowSnapshot; sections: MediaRowSnapshot | null; layout: { tv_rect: HeroTvRect; revision: number } | null };
  const remove: string[] = [];
  if (oldPrimaryPath && oldPrimaryPath !== storagePath) remove.push(oldPrimaryPath);
  if (oldSectionsPath && oldSectionsPath !== storagePath && !remove.includes(oldSectionsPath)) {
    remove.push(oldSectionsPath);
  }
  for (const action of decideMediaRollback({
    newObjectUploaded: true, dbCommitted: true, oldObjectSuperseded: remove.length > 0,
  })) {
    if (action === "delete-old-object" && remove.length > 0) {
      await removeHomepageMedia(remove);
    }
  }

  return {
    ok: true,
    record: toSafeSlotRecord(committed.media, homepageMediaPublicUrl(committed.media.storage_path)),
    sectionsRecord: committed.sections ? toSafeSlotRecord(committed.sections, homepageMediaPublicUrl(committed.sections.storage_path)) : null,
    layout: committed.layout ? { rect: committed.layout.tv_rect, revision: committed.layout.revision } : null,
  };
}

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; message: string; status: number };

/**
 * Revert-a-slot flow (Correction 2): the metadata delete (PostgreSQL, through the
 * backend) first, then best-effort storage cleanup. Never deletes the object
 * before metadata removal succeeds. Reverting is always safe: the public
 * homepage falls back to the committed local assets.
 */
export async function deleteHomepageMedia(
  context: VerifiedAuthContext,
  slot: HomepageMediaSlot,
): Promise<DeleteMediaResult> {
  const out = await revertHomepageMedia(context, slot);
  if (!out.ok) {
    const f = failureOf(out);
    return { ok: false, message: f.message, status: f.status };
  }
  const prev = out.value;
  if (typeof prev.storage_path === "string" && prev.storage_path.length > 0) {
    await removeHomepageMedia([prev.storage_path]);
  }
  return { ok: true };
}

export type UpdateHeroLayoutResult =
  | { ok: true; rect: HeroTvRect; revision: number }
  | { ok: false; message: string; status: number; code: string };

/** Standalone calibration edit (no media change): validate -> backend (trusted function). */
export async function updateHeroLayout(
  context: VerifiedAuthContext,
  rect: unknown,
  expectedRevision: unknown,
): Promise<UpdateHeroLayoutResult> {
  if (validateHeroTvRect(rect).length > 0) {
    return { ok: false, message: "مختصات موقعیت تلویزیون معتبر نیست.", status: 422, code: "HOMEPAGE_LAYOUT_INVALID" };
  }
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, message: "نسخه مورد انتظار نامعتبر است.", status: 400, code: "HOMEPAGE_LAYOUT_CONFLICT" };
  }

  const out = await saveHeroLayout(context, rect, expectedRevision);
  if (!out.ok) {
    const f = failureOf(out);
    return { ok: false, message: f.message, status: f.status, code: f.code };
  }
  return { ok: true, rect: out.value.tv_rect as HeroTvRect, revision: out.value.revision };
}

export { requireAdminHomepageAuth };

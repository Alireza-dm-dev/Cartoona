import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  HOMEPAGE_MEDIA_SLOT_SPECS,
  HOMEPAGE_MEDIA_SLOT_VALUES,
  type HomepageMediaSlot,
} from "@/lib/homepage/media-slots";
import { validateHeroTvRect, type HeroTvRect } from "@/lib/homepage/hero-layout";
import {
  HOMEPAGE_MEDIA_BUCKET,
  buildMediaStoragePath,
  decideMediaRollback,
  isSharedBackground,
  toSafeSlotRecord,
  validateUploadCandidate,
  type MediaRowSnapshot,
  type SafeSlotRecord,
} from "@/lib/admin/homepage/media-validation";
import { mapAdminHomepageMediaRpcError } from "@/lib/admin/homepage/media-errors";
import { requireAdminHomepageAuth } from "@/lib/admin/homepage/service";

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

export interface AdminMediaSlotView extends SafeSlotRecord {
  label: string;
  geometryCoupled: boolean;
  currentPublicPath: string;
}

export interface AdminMediaOverview {
  slots: AdminMediaSlotView[];
  heroLayout: { rect: HeroTvRect; revision: number } | null;
  sharedBackground: boolean;
}

function publicPreviewUrl(supabase: SupabaseClient, storagePath: string): string {
  const { data } = supabase.storage.from(HOMEPAGE_MEDIA_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

function parseRow(row: Record<string, unknown>): MediaRowSnapshot {
  return {
    slot_key: String(row.slot_key ?? ""),
    media_type: String(row.media_type ?? ""),
    storage_path: String(row.storage_path ?? ""),
    mime_type: String(row.mime_type ?? ""),
    byte_size: Number(row.byte_size ?? 0),
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
    duration_seconds:
      typeof row.duration_seconds === "number" || typeof row.duration_seconds === "string"
        ? row.duration_seconds
        : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
  };
}

/**
 * Reads all media rows + hero layout for the admin manager. Never throws:
 * missing tables/rows degrade to local-asset fallback views (previewUrl =
 * committed /public path, metadata nulls). No browser fallback writes.
 */
export async function queryAdminHomepageMedia(
  supabase: SupabaseClient,
): Promise<AdminMediaOverview> {
  let rows: Record<string, unknown>[] = [];
  let layout: { rect: HeroTvRect; revision: number } | null = null;

  try {
    const { data } = await supabase.from("homepage_media_assets").select("*");
    if (Array.isArray(data)) rows = data as Record<string, unknown>[];
  } catch {
    rows = [];
  }

  try {
    const { data } = await supabase
      .from("homepage_hero_layout")
      .select("tv_rect, revision")
      .eq("singleton_key", "hero")
      .maybeSingle();
    if (data && validateHeroTvRect(data.tv_rect).length === 0 && typeof data.revision === "number") {
      layout = { rect: data.tv_rect as HeroTvRect, revision: data.revision };
    }
  } catch {
    layout = null;
  }

  const bySlot = new Map(rows.map((r) => [String(r.slot_key), parseRow(r)]));
  const slots: AdminMediaSlotView[] = HOMEPAGE_MEDIA_SLOT_VALUES.map((slot) => {
    const spec = HOMEPAGE_MEDIA_SLOT_SPECS[slot];
    const row = bySlot.get(slot);
    const previewUrl = row ? publicPreviewUrl(supabase, row.storage_path) : spec.currentPublicPath;
    const base: SafeSlotRecord = row
      ? toSafeSlotRecord(row, previewUrl)
      : {
          slotKey: slot,
          mediaType: spec.mediaType,
          previewUrl,
          mimeType: "",
          byteSize: 0,
          width: null,
          height: null,
          durationSeconds: null,
          updatedAt: "",
        };
    return { ...base, label: spec.label, geometryCoupled: spec.geometryCoupled, currentPublicPath: spec.currentPublicPath };
  });

  return {
    slots,
    heroLayout: layout,
    sharedBackground: isSharedBackground(
      bySlot.get("hero.background")?.storage_path ?? null,
      bySlot.get("sections.background")?.storage_path ?? null,
    ),
  };
}

export type ReplaceMediaResult =
  | { ok: true; record: SafeSlotRecord; sectionsRecord: SafeSlotRecord | null; layout: { rect: HeroTvRect; revision: number } | null }
  | { ok: false; message: string; status: number; code: string };

interface ReplaceMediaInput {
  adminUserId: string;
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

  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return fail("عملیات رسانه انجام نشد.", 500, "HOMEPAGE_UNKNOWN_ERROR");
  }

  // ── old snapshot (for post-success cleanup only) ──
  let oldPrimaryPath: string | null = null;
  let oldSectionsPath: string | null = null;
  try {
    const { data } = await admin.from("homepage_media_assets").select("slot_key, storage_path");
    if (Array.isArray(data)) {
      for (const r of data as Record<string, unknown>[]) {
        if (r.slot_key === input.slot && typeof r.storage_path === "string") oldPrimaryPath = r.storage_path;
        if (input.applyToSections && r.slot_key === "sections.background" && typeof r.storage_path === "string") {
          oldSectionsPath = r.storage_path;
        }
      }
    }
  } catch {
    return fail("عملیات رسانه انجام نشد.", 500, "HOMEPAGE_UNKNOWN_ERROR");
  }

  // ── upload new object (server-generated path) ──
  const storagePath = buildMediaStoragePath(
    input.slot, mime, Date.now(), crypto.randomUUID(),
  );
  const uploadBytes = input.fileBytes.slice();
  const { error: uploadError } = await admin.storage
    .from(HOMEPAGE_MEDIA_BUCKET)
    .upload(storagePath, uploadBytes, { contentType: mime, upsert: false });
  if (uploadError) {
    return fail("بارگذاری فایل انجام نشد.", 500, "HOMEPAGE_UNKNOWN_ERROR");
  }

  // ── ONE atomic commit ──
  const { data: rpcData, error: rpcError } = await admin.rpc(
    "record_homepage_media_replacement_trusted",
    {
      p_admin_user_id: input.adminUserId,
      p_primary_slot: input.slot,
      p_media_type: mediaType,
      p_storage_path: storagePath,
      p_mime_type: mime,
      p_byte_size: byteSize,
      p_width: width,
      p_height: height,
      p_duration_seconds: null,
      p_hero_tv_rect: input.slot === "hero.background" ? (input.tvRect as HeroTvRect) : null,
      p_expected_layout_revision: input.expectedLayoutRevision,
      p_apply_to_sections: input.applyToSections,
    },
  );

  if (rpcError || !rpcData) {
    // DB did not commit: previous state intact — remove the orphan object.
    for (const action of decideMediaRollback({ newObjectUploaded: true, dbCommitted: false, oldObjectSuperseded: false })) {
      if (action === "delete-new-object") {
        await admin.storage.from(HOMEPAGE_MEDIA_BUCKET).remove([storagePath]).catch(() => {});
      }
    }
    const mapped = mapAdminHomepageMediaRpcError(rpcError?.message);
    if (mapped.code === "HOMEPAGE_LAYOUT_CONFLICT") {
      return fail(mapped.message, 409, mapped.code);
    }
    return fail(mapped.message, mapped.status, mapped.code);
  }

  // ── post-success cleanup: superseded objects only, best-effort ──
  const committed = rpcData as { media: MediaRowSnapshot; sections: MediaRowSnapshot | null; layout: { tv_rect: HeroTvRect; revision: number } | null };
  const remove: string[] = [];
  if (oldPrimaryPath && oldPrimaryPath !== storagePath) remove.push(oldPrimaryPath);
  if (oldSectionsPath && oldSectionsPath !== storagePath && !remove.includes(oldSectionsPath)) {
    remove.push(oldSectionsPath);
  }
  for (const action of decideMediaRollback({
    newObjectUploaded: true, dbCommitted: true, oldObjectSuperseded: remove.length > 0,
  })) {
    if (action === "delete-old-object" && remove.length > 0) {
      await admin.storage.from(HOMEPAGE_MEDIA_BUCKET).remove(remove).catch(() => {});
    }
  }

  const server = await createServerSupabaseClient().catch(() => null);
  const preview = (p: string) =>
    server ? publicPreviewUrl(server, p) : publicPreviewUrl(admin, p);

  return {
    ok: true,
    record: toSafeSlotRecord(committed.media, preview(committed.media.storage_path)),
    sectionsRecord: committed.sections ? toSafeSlotRecord(committed.sections, preview(committed.sections.storage_path)) : null,
    layout: committed.layout ? { rect: committed.layout.tv_rect, revision: committed.layout.revision } : null,
  };
}

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; message: string; status: number };

/**
 * Revert-a-slot flow (Correction 2): trusted metadata-delete RPC first, then
 * best-effort storage cleanup. Never deletes the object before metadata
 * removal succeeds. Reverting is always safe: the public homepage renders
 * committed local assets until Phase 4.
 */
export async function deleteHomepageMedia(
  adminUserId: string,
  slot: HomepageMediaSlot,
): Promise<DeleteMediaResult> {
  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, message: "عملیات رسانه انجام نشد.", status: 500 };
  }

  const { data, error } = await admin.rpc("delete_homepage_media_trusted", {
    p_admin_user_id: adminUserId,
    p_slot_key: slot,
  });
  if (error || !data) {
    const mapped = mapAdminHomepageMediaRpcError(error?.message);
    return { ok: false, message: mapped.message, status: mapped.status };
  }

  const prev = data as { storage_path?: unknown };
  if (typeof prev.storage_path === "string" && prev.storage_path.length > 0) {
    await admin.storage.from(HOMEPAGE_MEDIA_BUCKET).remove([prev.storage_path]).catch(() => {});
  }
  return { ok: true };
}

export type UpdateHeroLayoutResult =
  | { ok: true; rect: HeroTvRect; revision: number }
  | { ok: false; message: string; status: number; code: string };

/** Standalone calibration edit (no media change): validate → trusted RPC. */
export async function updateHeroLayout(
  adminUserId: string,
  rect: unknown,
  expectedRevision: unknown,
): Promise<UpdateHeroLayoutResult> {
  if (validateHeroTvRect(rect).length > 0) {
    return { ok: false, message: "مختصات موقعیت تلویزیون معتبر نیست.", status: 422, code: "HOMEPAGE_LAYOUT_INVALID" };
  }
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, message: "نسخه مورد انتظار نامعتبر است.", status: 400, code: "HOMEPAGE_LAYOUT_CONFLICT" };
  }

  let admin;
  try {
    admin = createAdminSupabaseClient();
  } catch {
    return { ok: false, message: "عملیات رسانه انجام نشد.", status: 500, code: "HOMEPAGE_UNKNOWN_ERROR" };
  }

  const { data, error } = await admin.rpc("update_homepage_hero_layout_trusted", {
    p_admin_user_id: adminUserId,
    p_tv_rect: rect as HeroTvRect,
    p_expected_revision: expectedRevision,
  });
  if (error || !data) {
    const mapped = mapAdminHomepageMediaRpcError(error?.message);
    if (mapped.code === "HOMEPAGE_LAYOUT_CONFLICT") {
      return { ok: false, message: mapped.message, status: 409, code: mapped.code };
    }
    return { ok: false, message: mapped.message, status: mapped.status, code: mapped.code };
  }
  const row = data as { tv_rect: HeroTvRect; revision: number };
  return { ok: true, rect: row.tv_rect, revision: row.revision };
}

export { requireAdminHomepageAuth };

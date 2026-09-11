"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DEFAULT_TV_RECT } from "@/lib/homepage/hero-layout";
import type { AdminMediaSlotView } from "@/lib/admin/homepage/media-service";
import {
  formatFileSize,
  precheckFileForSlot,
  type MediaSaveOutcome,
} from "@/lib/admin/homepage/media-editor-state";
import { HeroCalibration } from "@/components/admin/homepage/hero-calibration";
import { MediaSlotCard } from "@/components/admin/homepage/media-slot-card";
import type { HomepageMediaSlot } from "@/lib/homepage/media-slots";

interface HeroMediaPanelProps {
  heroBg: AdminMediaSlotView | null;
  tvVideo: AdminMediaSlotView | null;
  sharedBackground: boolean;
  layoutRect: { x: number; y: number; width: number; height: number };
  layoutRevision: number | null;
  busy: boolean;
  onUpload: (
    slot: HomepageMediaSlot,
    file: File,
    extra: Record<string, string>,
  ) => Promise<MediaSaveOutcome>;
  onRevert: (slot: HomepageMediaSlot) => Promise<{ ok: true } | { ok: false; message: string }>;
  onSaveLayout: (
    rect: { x: number; y: number; width: number; height: number },
    expectedRevision: number,
  ) => Promise<{ kind: string; message?: string }>;
}

/**
 * Hero tab: background image (calibration-gated upload), TV video
 * (independent upload, muted preview), TV-rect recalibration for the current
 * artwork, and the hero/sections sharing mode switch.
 */
export function HeroMediaPanel({
  heroBg,
  tvVideo,
  sharedBackground,
  layoutRect,
  layoutRevision,
  busy,
  onUpload,
  onRevert,
  onSaveLayout,
}: HeroMediaPanelProps) {
  const [shared, setShared] = useState(sharedBackground);
  const [selected, setSelected] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [artworkSize, setArtworkSize] = useState<{ width: number; height: number } | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [calibError, setCalibError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Adjust local toggle during render when the server truth changes
  // (refresh after save) — render-phase setState, no effect needed.
  const [prevSharedBackground, setPrevSharedBackground] = useState(sharedBackground);
  if (prevSharedBackground !== sharedBackground) {
    setPrevSharedBackground(sharedBackground);
    setShared(sharedBackground);
  }

  const objectUrlRef = useRef<string | null>(null);

  // Revoke only (no setState) on unmount.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function clearBgSelection() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setObjectUrl(null);
    setArtworkSize(null);
    setSelected(null);
  }

  const startRect = useMemo(() => ({ ...DEFAULT_TV_RECT, ...layoutRect }), [layoutRect]);

  function handleSelect(file: File | undefined) {
    setMessage(null);
    clearBgSelection();
    if (!file) {
      setPrecheckError(null);
      return;
    }
    const check = precheckFileForSlot("hero.background", { name: file.name, type: file.type, size: file.size });
    if (!check.ok) {
      setPrecheckError(check.message);
      return;
    }
    setPrecheckError(null);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setObjectUrl(url);
    const img = new Image();
    img.onload = () => setArtworkSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => setArtworkSize(null);
    img.src = url;
    setSelected(file);
  }

  async function handleCalibrationConfirm(rect: { x: number; y: number; width: number; height: number }) {
    if (!selected || layoutRevision === null) return;
    setConfirming(true);
    setCalibError(null);
    const outcome = await onUpload("hero.background", selected, {
      tv_rect: JSON.stringify(rect),
      expected_layout_revision: String(layoutRevision),
      apply_to_sections: shared ? "true" : "false",
    });
    setConfirming(false);
    if (outcome.kind === "saved") {
      setCalibrating(false);
      clearBgSelection();
      setMessage({ kind: "success", text: "پس‌زمینه هیرو با کالیبراسیون جدید ذخیره شد." });
    } else {
      // New upload failed safely: nothing activated, file kept for retry.
      setCalibError(outcome.message);
    }
  }

  async function handleRecalibrateConfirm(rect: { x: number; y: number; width: number; height: number }) {
    if (layoutRevision === null) return;
    setConfirming(true);
    setCalibError(null);
    const outcome = await onSaveLayout(rect, layoutRevision);
    setConfirming(false);
    if (outcome.kind === "saved") {
      setRecalibrating(false);
      setMessage({ kind: "success", text: "کالیبراسیون موقعیت تلویزیون ذخیره شد." });
    } else {
      setCalibError(outcome.message ?? "ذخیره کالیبراسیون انجام نشد.");
    }
  }

  const layoutUnavailable = layoutRevision === null;

  return (
    <div className="space-y-6">
      {/* Sharing mode */}
      <Card variant="admin" className="space-y-3">
        <h3 className="text-sm font-bold text-parent-navy">حالت پس‌زمینه هیرو و بخش‌ها</h3>
        <label className="flex items-start gap-2 text-sm text-text-dark">
          <input
            type="radio"
            name="bg-share-mode"
            checked={shared}
            disabled={busy}
            onChange={() => setShared(true)}
            className="mt-1 h-4 w-4"
          />
          <span>استفاده از یک تصویر برای هیرو و پس‌زمینه بخش‌ها
            <span className="block text-xs text-text-dark/60">آپلود هیرو هر دو جایگاه را با همین فایل به‌روزرسانی می‌کند؛ پیش از ذخیره به‌وضوح اعلام می‌شود.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text-dark">
          <input
            type="radio"
            name="bg-share-mode"
            checked={!shared}
            disabled={busy}
            onChange={() => setShared(false)}
            className="mt-1 h-4 w-4"
          />
          <span>استفاده از تصاویر جداگانه
            <span className="block text-xs text-text-dark/60">پس‌زمینه بخش‌ها مستقلاً در زبانه خودش مدیریت می‌شود.</span>
          </span>
        </label>
        <p className="text-xs text-text-dark/50" role="status">
          وضعیت فعلی: {sharedBackground ? "یک تصویر مشترک" : "تصاویر جداگانه"}
          {layoutRevision !== null ? ` · نسخه کالیبراسیون: ${layoutRevision}` : " · کالیبراسیون در دسترس نیست"}
        </p>
      </Card>

      {/* Hero background (calibration-gated) */}
      <Card variant="admin" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-parent-navy">تصویر پس‌زمینه هیرو</h3>
          <span className="rounded-full bg-cream px-3 py-1 text-xs font-semibold text-text-dark/60" role="status">
            {heroBg?.mimeType ? "رسانه CMS" : "پیش‌فرض پروژه"}
          </span>
        </div>
        <p className="text-xs text-coral">
          این تصویر به موقعیت ویدیوی تلویزیون وابسته است. جایگزینی آن بدون تأیید کالیبراسیون فعال نمی‌شود.
        </p>
        <div className="overflow-hidden rounded-xl border border-soft-border bg-cream/40">
          <img src={heroBg?.previewUrl} alt="پیش‌نمایش پس‌زمینه هیرو" className="block max-h-64 w-full object-contain" />
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-text-dark">
            انتخاب تصویر جایگزین
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy || layoutUnavailable}
              onChange={(e) => handleSelect(e.target.files?.[0])}
              className="mt-1 block w-full text-xs text-text-dark file:ml-2 file:rounded-lg file:border file:border-soft-border file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-cream"
            />
          </label>
          {layoutUnavailable && (
            <p className="text-xs text-coral" role="alert">جدول کالیبراسیون در دسترس نیست؛ آپلود هیرو غیرفعال است.</p>
          )}
          {precheckError && (
            <p className="text-xs text-coral" role="alert">{precheckError}</p>
          )}
          {selected && (
            <div className="space-y-2 rounded-xl border border-candy-pink/30 bg-candy-pink/5 p-3">
              <p className="text-xs text-text-dark"><span className="font-medium">فایل انتخاب‌شده:</span> {selected.name} · {formatFileSize(selected.size)}</p>
              {shared && (
                <p className="text-xs font-medium text-text-dark" role="status">
                  این فایل برای هیرو و پس‌زمینه بخش‌ها (هر دو جایگاه) ذخیره خواهد شد.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={busy || layoutUnavailable} onClick={() => { setCalibError(null); setCalibrating(true); }}>
                  ادامه به کالیبراسیون
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={clearBgSelection}>
                  انصراف
                </Button>
              </div>
            </div>
          )}
          {message && (
            <p className={`text-xs ${message.kind === "success" ? "text-mint-green" : "text-coral"}`} role={message.kind === "success" ? "status" : "alert"}>
              {message.text}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="secondary" size="sm" disabled={busy || layoutUnavailable} onClick={() => { setCalibError(null); setRecalibrating(true); }}>
              ویرایش کالیبراسیون فعلی
            </Button>
          </div>
        </div>
      </Card>

      {/* TV video (independent) */}
      <MediaSlotCard
        slot="hero.tv_video"
        view={tvVideo}
        busy={busy}
        warning={<p className="text-xs text-text-dark/60">ویدیو داخل قاب تلویزیون پخش می‌شود؛ نسبت ابعاد نزدیک ۱٫۲۷ کمترین برش را دارد.</p>}
        onUpload={async (slot, file, extra) => {
          const outcome = await onUpload(slot, file, extra);
          return outcome.kind === "saved" ? { ok: true as const } : { ok: false as const, message: outcome.message };
        }}
        onRevert={onRevert}
      />

      {calibrating && objectUrl && (
        <HeroCalibration
          imageSrc={objectUrl}
          tvVideoSrc={tvVideo?.previewUrl ?? null}
          initialRect={startRect}
          artworkSize={artworkSize}
          busy={confirming || busy}
          serverError={calibError}
          onConfirm={handleCalibrationConfirm}
          onCancel={() => { if (!confirming) setCalibrating(false); }}
        />
      )}
      {recalibrating && heroBg?.previewUrl && (
        <HeroCalibration
          imageSrc={heroBg.previewUrl}
          tvVideoSrc={tvVideo?.previewUrl ?? null}
          initialRect={startRect}
          artworkSize={null}
          initialConfirmed
          busy={confirming || busy}
          serverError={calibError}
          onConfirm={handleRecalibrateConfirm}
          onCancel={() => { if (!confirming) setRecalibrating(false); }}
        />
      )}
    </div>
  );
}

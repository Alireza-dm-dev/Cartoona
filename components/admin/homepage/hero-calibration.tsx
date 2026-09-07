"use client";

import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  aspectCompatibilityNote,
  validateHeroTvRect,
  type HeroTvRect,
} from "@/lib/homepage/hero-layout";
import {
  clampHeroRect,
  formatPercentFraction,
  moveHeroRectByPixels,
  parsePercentInput,
  resizeHeroRectByPixels,
} from "@/lib/admin/homepage/media-editor-state";

interface HeroCalibrationProps {
  /** Object URL (new upload) or current hero preview URL (recalibration). */
  imageSrc: string;
  /** Muted TV clip preview URL (CMS tv video or local fallback). */
  tvVideoSrc: string | null;
  initialRect: HeroTvRect;
  /** Real pixel dimensions of the artwork being calibrated, when known. */
  artworkSize: { width: number; height: number } | null;
  initialConfirmed?: boolean;
  busy: boolean;
  serverError: string | null;
  onConfirm: (rect: HeroTvRect) => void;
  onCancel: () => void;
}

const numInputClass =
  "w-full rounded-xl border border-soft-border bg-white px-3 py-2 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10 disabled:opacity-50";

/**
 * TV-rect calibration dialog. Normalized fractions stay authoritative; the UI
 * shows percentages. Drag + resize via pointer events on larger screens;
 * numeric controls are always present (mandatory on small screens).
 */
export function HeroCalibration({
  imageSrc,
  tvVideoSrc,
  initialRect,
  artworkSize,
  initialConfirmed = false,
  busy,
  serverError,
  onConfirm,
  onCancel,
}: HeroCalibrationProps) {
  const [rect, setRect] = useState<HeroTvRect>(() => clampHeroRect(initialRect));
  const [confirmed, setConfirmed] = useState(initialConfirmed);
  const [dragging, setDragging] = useState(false);
  const [numeric, setNumeric] = useState({
    x: (initialRect.x * 100).toFixed(1),
    y: (initialRect.y * 100).toFixed(1),
    width: (initialRect.width * 100).toFixed(1),
    height: (initialRect.height * 100).toFixed(1),
  });
  const frameRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; base: HeroTvRect } | null>(null);

  function syncNumeric(r: HeroTvRect) {
    setNumeric({
      x: (r.x * 100).toFixed(1),
      y: (r.y * 100).toFixed(1),
      width: (r.width * 100).toFixed(1),
      height: (r.height * 100).toFixed(1),
    });
  }

  const errors = validateHeroTvRect(rect);
  const errorMap = new Map(errors.map((e) => [e.field, e.message]));
  const aspectNote = aspectCompatibilityNote(artworkSize?.width ?? null, artworkSize?.height ?? null);
  const canConfirm = errors.length === 0 && confirmed && !busy;

  function frameSize(): { w: number; h: number } {
    const el = frameRef.current;
    if (!el) return { w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function onPointerDown(e: React.PointerEvent, mode: "move" | "resize") {
    if (busy) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    gestureRef.current = { mode, startX: e.clientX, startY: e.clientY, base: rect };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    const { w, h } = frameSize();
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const next = g.mode === "move"
      ? moveHeroRectByPixels(g.base, dx, dy, w, h)
      : resizeHeroRectByPixels(g.base, dx, dy, w, h);
    setRect(next);
    syncNumeric(next);
  }

  function endGesture() {
    gestureRef.current = null;
    setDragging(false);
  }

  function applyNumeric(key: keyof HeroTvRect, raw: string) {
    setNumeric((n) => ({ ...n, [key]: raw }));
    const v = parsePercentInput(raw);
    if (v === null) return;
    const next = clampHeroRect({ ...rect, [key]: v });
    setRect(next);
    syncNumeric(next);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-parent-navy/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="کالیبراسیون موقعیت تلویزیون">
      <Card variant="admin" className="max-h-[92vh] w-full max-w-[880px] overflow-y-auto">
        <h2 className="text-base font-bold text-parent-navy">تنظیم محل نمایش ویدیو روی تصویر</h2>
        <p className="mt-1 text-sm text-coral" role="alert">
          این تصویر به موقعیت ویدیوی تلویزیون وابسته است. لطفاً محل نمایش ویدیو را روی تصویر تنظیم کنید.
        </p>
        {aspectNote && (
          <p className="mt-2 text-sm text-coral" role="alert">
            {aspectNote}
          </p>
        )}

        {/* Preview frame: artwork + draggable/resizable TV overlay */}
        <div
          ref={frameRef}
          className="relative mt-4 w-full touch-none overflow-hidden rounded-xl border border-soft-border bg-cream select-none"
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <img src={imageSrc} alt="پیش‌نمایش پس‌زمینه هیرو" className="block w-full" draggable={false} />
          <div
            className={`absolute overflow-hidden rounded-md border-2 bg-black/60 ${dragging ? "border-candy-pink" : "border-candy-pink/80"} cursor-move`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
            onPointerDown={(e) => onPointerDown(e, "move")}
            aria-label="قاب موقعیت تلویزیون — بکشید تا جابه‌جا شود"
          >
            {tvVideoSrc ? (
              <video src={tvVideoSrc} muted playsInline autoPlay loop preload="auto" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-white/70">پیش‌نمایش ویدیو</div>
            )}
            <button
              type="button"
              aria-label="تغییر اندازه قاب"
              className="absolute bottom-0 left-0 h-6 w-6 cursor-nwse-resize rounded-tr-lg bg-candy-pink"
              onPointerDown={(e) => {
                e.stopPropagation();
                onPointerDown(e, "resize");
              }}
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-text-dark/50">
          قاب را بکشید تا جابه‌جا شود؛ دستگیره صورتی پایین قاب برای تغییر اندازه است. در صفحه‌های کوچک از ورودی‌های عددی زیر استفاده کنید.
        </p>

        {/* Numeric controls (percentages; mandatory path on mobile) */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["x", "y", "width", "height"] as const).map((key) => (
            <div key={key} className="space-y-1">
              <label htmlFor={`cal-${key}`} className="block text-xs font-medium text-text-dark">
                {key === "x" ? "X (٪)" : key === "y" ? "Y (٪)" : key === "width" ? "عرض (٪)" : "ارتفاع (٪)"}
              </label>
              <input
                id={`cal-${key}`}
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={0.1}
                value={numeric[key]}
                disabled={busy}
                onChange={(e) => applyNumeric(key, e.target.value)}
                className={numInputClass}
                dir="ltr"
              />
              {errorMap.get(key) && (
                <p className="text-xs text-coral" role="alert">{errorMap.get(key)}</p>
              )}
            </div>
          ))}
        </div>
        {errorMap.get("rect") && (
          <p className="mt-2 text-xs text-coral" role="alert">{errorMap.get("rect")}</p>
        )}
        <p className="mt-2 text-xs text-text-dark/60">
          موقعیت فعلی: X ‏{formatPercentFraction(rect.x)}، Y ‏{formatPercentFraction(rect.y)}، عرض ‏{formatPercentFraction(rect.width)}، ارتفاع ‏{formatPercentFraction(rect.height)}
        </p>

        <label className="mt-4 flex items-start gap-2 text-sm text-text-dark">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-soft-border"
          />
          موقعیت ویدیوی تلویزیون را روی تصویر بررسی و تأیید می‌کنم.
        </label>

        {serverError && (
          <p className="mt-2 text-sm text-coral" role="alert">{serverError}</p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" disabled={!canConfirm} onClick={() => onConfirm(rect)}>
            {busy ? "در حال ذخیره…" : "تأیید کالیبراسیون و ذخیره"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            انصراف
          </Button>
        </div>
      </Card>
    </div>
  );
}

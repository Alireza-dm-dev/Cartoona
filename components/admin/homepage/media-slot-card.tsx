"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { HomepageMediaSlot } from "@/lib/homepage/media-slots";
import type { AdminMediaSlotView } from "@/lib/admin/homepage/media-service";
import {
  formatFileSize,
  precheckFileForSlot,
} from "@/lib/admin/homepage/media-editor-state";

interface MediaSlotCardProps {
  slot: HomepageMediaSlot;
  view: AdminMediaSlotView | null;
  busy: boolean;
  warning?: React.ReactNode;
  /** e.g. sections preview confirmation — must be checked before upload. */
  requireConfirm?: { label: string; hint?: string };
  /** Extra multipart fields merged into the upload request. */
  uploadExtra?: Record<string, string>;
  onUpload: (slot: HomepageMediaSlot, file: File, extra: Record<string, string>) => Promise<{ ok: true } | { ok: false; message: string }>;
  onRevert: (slot: HomepageMediaSlot) => Promise<{ ok: true } | { ok: false; message: string }>;
}

function formatDuration(seconds: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  return `${seconds.toFixed(1)} ثانیه`;
}

/**
 * Generic CMS media slot card: current preview (local fallback or CMS
 * override), metadata, replace flow with pending summary + cancel, revert to
 * local fallback. Never renders raw storage paths.
 */
export function MediaSlotCard({
  slot,
  view,
  busy,
  warning,
  requireConfirm,
  uploadExtra = {},
  onUpload,
  onRevert,
}: MediaSlotCardProps) {
  const [selected, setSelected] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [armingRevert, setArmingRevert] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  // Revoke only (no setState) on unmount.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function clearSelection() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPreviewUrl(null);
    setSelected(null);
    setConfirmed(false);
  }

  const isVideo = (view?.mediaType ?? "image") === "video";
  const hasOverride = Boolean(view && view.mimeType);

  function handleSelect(file: File | undefined) {
    setMessage(null);
    clearSelection();
    if (!file) {
      setPrecheckError(null);
      return;
    }
    const check = precheckFileForSlot(slot, { name: file.name, type: file.type, size: file.size });
    if (!check.ok) {
      setPrecheckError(check.message);
      return;
    }
    setPrecheckError(null);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setPreviewUrl(url);
    setSelected(file);
  }

  async function handleUpload() {
    if (!selected || uploading || busy) return;
    setUploading(true);
    setMessage(null);
    const outcome = await onUpload(slot, selected, uploadExtra);
    setUploading(false);
    if (outcome.ok) {
      clearSelection();
      setMessage({ kind: "success", text: "رسانه جدید ذخیره شد." });
    } else {
      // Old preview stays active; the file is kept for retry.
      setMessage({ kind: "error", text: outcome.message });
    }
  }

  async function handleRevert() {
    if (!armingRevert) {
      setArmingRevert(true);
      return;
    }
    setArmingRevert(false);
    const outcome = await onRevert(slot);
    setMessage(
      outcome.ok
        ? { kind: "success", text: "به فایل پیش‌فرض پروژه بازگشت." }
        : { kind: "error", text: outcome.message },
    );
  }

  const canUpload = selected && !uploading && !busy && (!requireConfirm || confirmed);

  return (
    <Card variant="admin" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-parent-navy">{view?.label ?? slot}</h3>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${hasOverride ? "bg-mint-green/15 text-mint-green" : "bg-cream text-text-dark/60"}`}
          role="status"
        >
          {hasOverride ? "رسانه CMS" : "پیش‌فرض پروژه"}
        </span>
      </div>

      {warning}

      {/* Current preview */}
      <div className="overflow-hidden rounded-xl border border-soft-border bg-cream/40">
        {isVideo ? (
          <video
            src={view?.previewUrl}
            muted
            controls
            playsInline
            preload="metadata"
            className="block max-h-64 w-full"
            aria-label={`پیش‌نمایش ویدیوی ${view?.label ?? slot}`}
          />
        ) : (
          <img
            src={view?.previewUrl}
            alt={`پیش‌نمایش ${view?.label ?? slot}`}
            className="block max-h-64 w-full object-contain"
          />
        )}
      </div>

      {/* Metadata */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-dark/70 sm:grid-cols-4">
        <div><dt className="font-medium">نوع</dt><dd>{isVideo ? "ویدیو" : "تصویر"}{view?.mimeType ? ` (${view.mimeType})` : ""}</dd></div>
        <div><dt className="font-medium">ابعاد</dt><dd dir="ltr">{view?.width && view?.height ? `${view.width}×${view.height}` : "—"}</dd></div>
        <div><dt className="font-medium">حجم</dt><dd>{formatFileSize(view?.byteSize ?? null)}</dd></div>
        <div><dt className="font-medium">مدت</dt><dd>{isVideo ? formatDuration(view?.durationSeconds ?? null) : "—"}</dd></div>
      </dl>

      {/* Replace flow */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-text-dark">
          انتخاب فایل جایگزین
          <input
            type="file"
            accept={isVideo ? "video/mp4,video/webm" : "image/png,image/jpeg,image/webp"}
            disabled={busy || uploading}
            onChange={(e) => handleSelect(e.target.files?.[0])}
            className="mt-1 block w-full text-xs text-text-dark file:ml-2 file:rounded-lg file:border file:border-soft-border file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-cream"
          />
        </label>
        {precheckError && (
          <p className="text-xs text-coral" role="alert">{precheckError}</p>
        )}

        {selected && (
          <div className="space-y-2 rounded-xl border border-candy-pink/30 bg-candy-pink/5 p-3">
            <p className="text-xs text-text-dark"><span className="font-medium">فایل انتخاب‌شده:</span> {selected.name}</p>
            <p className="text-xs text-text-dark/60">{selected.type || "نوع نامشخص"} · {formatFileSize(selected.size)}</p>
            {previewUrl && !isVideo && (
              <img src={previewUrl} alt="پیش‌نمایش فایل انتخاب‌شده" className="block max-h-40 w-full rounded-lg object-contain" />
            )}
            {requireConfirm && (
              <label className="flex items-start gap-2 text-xs text-text-dark">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || uploading}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-soft-border"
                />
                <span>{requireConfirm.label}{requireConfirm.hint && <span className="block text-text-dark/60">{requireConfirm.hint}</span>}</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" disabled={!canUpload} onClick={handleUpload}>
                {uploading ? "در حال آپلود…" : "آپلود و جایگزینی"}
              </Button>
              <Button variant="secondary" size="sm" disabled={uploading || busy} onClick={clearSelection}>
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

        {hasOverride && (
          <div className="pt-1">
            {!armingRevert ? (
              <Button variant="ghost" size="sm" disabled={busy || uploading} onClick={handleRevert}>
                بازگشت به فایل پیش‌فرض
              </Button>
            ) : (
              <div className="space-y-2 rounded-xl border border-coral/30 bg-coral/5 p-3">
                <p className="text-xs text-text-dark" role="alert">
                  نسخه سفارشی حذف می‌شود و فایل پیش‌فرض پروژه دوباره استفاده خواهد شد.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" disabled={busy} onClick={handleRevert}>
                    تأیید حذف نسخه سفارشی
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setArmingRevert(false)}>
                    انصراف
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

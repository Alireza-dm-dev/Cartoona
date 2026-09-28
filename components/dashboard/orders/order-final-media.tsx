"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/neu-button";
import type { ParentFinalMedia } from "@/lib/parent/orders/detail-types";

interface OrderFinalMediaProps {
  orderId: string;
  finalMedia: ParentFinalMedia;
}

interface SignedResult {
  url: string;
  expiresAt: string;
  mediaType: string | null;
  fileName: string | null;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; result: SignedResult }
  | { kind: "error" };

async function requestSignedUrl(
  orderId: string,
  action: "view" | "download",
): Promise<SignedResult | null> {
  try {
    const res = await fetch(`/api/parent/orders/${orderId}/final-media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as SignedResult | null;
    if (!body || typeof body.url !== "string") return null;
    return body;
  } catch {
    return null;
  }
}

function isVideoType(mediaType: string | null): boolean {
  return typeof mediaType === "string" && mediaType.startsWith("video/");
}

/**
 * "کارتون شما آماده است" — shown only once `finalMedia` is non-null, which
 * the server already decided purely from the media-level predicate (approved
 * + parent-visible), independent of `order.status`. This component never
 * re-derives or second-guesses that: it has nothing to gate on beyond having
 * been rendered at all.
 *
 * The inline preview and both actions each mint their own short-lived signed
 * URL on demand — none is embedded at page-render time, so nothing here can
 * go stale between a page load and a parent's click.
 */
export function OrderFinalMedia({ orderId, finalMedia }: OrderFinalMediaProps) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestSignedUrl(orderId, "view").then((result) => {
      if (cancelled) return;
      setPreview(result ? { kind: "ready", result } : { kind: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function handleView() {
    setActionError(null);
    // The inline preview may already be minutes old by the time this is
    // clicked, so "مشاهده نتیجه" always fetches a fresh URL rather than
    // reusing whatever loaded the preview.
    const fresh = await requestSignedUrl(orderId, "view");
    if (!fresh) {
      setActionError("در حال حاضر امکان مشاهده وجود ندارد. لطفاً دوباره تلاش کنید.");
      return;
    }
    window.open(fresh.url, "_blank", "noopener,noreferrer");
  }

  async function handleDownload() {
    setActionError(null);
    setDownloading(true);
    try {
      const fresh = await requestSignedUrl(orderId, "download");
      if (!fresh) {
        setActionError("دانلود در حال حاضر امکان‌پذیر نیست. لطفاً دوباره تلاش کنید.");
        return;
      }
      const link = document.createElement("a");
      link.href = fresh.url;
      link.rel = "noopener noreferrer";
      link.click();
    } finally {
      setDownloading(false);
    }
  }

  const isVideo = isVideoType(finalMedia.mimeType);
  const downloadLabel = isVideo ? "دانلود ویدیو" : "دانلود تصویر";

  return (
    <Card className="border-mint-green/30 bg-mint-green/5">
      <h2 className="mb-1 font-semibold text-parent-navy">کارتون شما آماده است 🎉</h2>
      <p className="mb-4 text-sm text-text-dark/60">
        می‌توانید نتیجه نهایی را مشاهده یا دانلود کنید.
      </p>

      <div className="mb-4 neu-recessed overflow-hidden rounded-xl">
        {preview.kind === "loading" && (
          <div className="flex aspect-video w-full items-center justify-center text-xs text-text-dark/50">
            در حال بارگذاری پیش‌نمایش…
          </div>
        )}
        {preview.kind === "error" && (
          <div className="flex aspect-video w-full items-center justify-center text-center text-xs text-text-dark/50">
            پیش‌نمایش موقتاً در دسترس نیست.
          </div>
        )}
        {preview.kind === "ready" && !isVideo && (
          // A plain <img>, deliberately: the URL is short-lived and must never
          // pass through the Next image optimiser, which would cache a copy
          // of a private deliverable behind a stable public URL.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.result.url}
            alt="نتیجه نهایی سفارش شما"
            className="max-h-[420px] w-full object-contain"
          />
        )}
        {preview.kind === "ready" && isVideo && (
          <video
            src={preview.result.url}
            controls
            className="max-h-[420px] w-full bg-black"
          />
        )}
      </div>

      {actionError && (
        <p className="mb-3 text-sm text-coral" role="alert">
          {actionError}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          className="min-h-11 flex-1 sm:flex-none"
          onClick={handleView}
        >
          مشاهده نتیجه
        </Button>
        <Button
          variant="primary"
          className="min-h-11 flex-1 sm:flex-none"
          onClick={handleDownload}
          disabled={downloading}
        >
          {downloading ? "در حال آماده‌سازی…" : downloadLabel}
        </Button>
      </div>
    </Card>
  );
}

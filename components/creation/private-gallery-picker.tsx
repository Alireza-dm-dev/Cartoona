"use client";

import { useEffect, useState } from "react";
import { appendUniqueById } from "@/lib/parent/gallery/pagination";
import type { ParentGalleryMedia } from "@/lib/parent/gallery/types";

type LoadPhase = "loading" | "ready" | "error";

/**
 * "انتخاب از گالری خصوصی" — reuse a source file the parent already uploaded.
 *
 * Only rendered at /complete-request, where the parent is already
 * authenticated. The public creation pages keep working anonymously and are
 * deliberately left alone: nobody is asked to log in early just to be shown
 * this.
 *
 * Nothing is submitted on the parent's behalf. Even when a previous file is
 * the obvious candidate it is only *suggested* — `selectedId` stays null until
 * the parent picks, so an old child photo can never ride along unnoticed.
 */
export function PrivateGalleryPicker({
  selectedId,
  onSelect,
  onCancel,
}: {
  selectedId: string | null;
  onSelect: (media: ParentGalleryMedia) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [media, setMedia] = useState<ParentGalleryMedia[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const res = await fetch(`/api/parent/gallery?cursor=${encodeURIComponent(cursor)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("gallery page failed");
      const body = await res.json();
      const next: ParentGalleryMedia[] = Array.isArray(body?.media) ? body.media : [];
      setMedia((prev) => appendUniqueById(prev, next));
      setCursor(typeof body?.nextCursor === "string" ? body.nextCursor : null);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch("/api/parent/gallery", { cache: "no-store" });
        if (!active) return;
        if (!res.ok) {
          setPhase("error");
          return;
        }
        const body = await res.json();
        if (!active) return;
        setMedia(Array.isArray(body?.media) ? body.media : []);
        setCursor(typeof body?.nextCursor === "string" ? body.nextCursor : null);
        setPhase("ready");
      } catch {
        if (active) setPhase("error");
      }
    }

    load();
    return () => {
      active = false;
    };
  }, []);

  if (phase === "loading") {
    return (
      <p className="text-sm text-text-dark/50" aria-live="polite">
        در حال بارگذاری گالری خصوصی…
      </p>
    );
  }

  if (phase === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-coral" role="alert">
          گالری خصوصی در دسترس نیست. می‌توانید فایل جدیدی بارگذاری کنید.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-candy-pink hover:opacity-80"
        >
          بارگذاری فایل جدید
        </button>
      </div>
    );
  }

  if (media.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-text-dark/60">
          هنوز فایلی در گالری خصوصی شما نیست. فایل‌هایی که برای درخواست‌ها
          بارگذاری می‌کنید، بعداً اینجا در دسترس خواهند بود.
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-candy-pink hover:opacity-80"
        >
          بارگذاری فایل جدید
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-dark/60">
        یکی از فایل‌های قبلی خود را انتخاب کنید. تا وقتی انتخاب شما ثبت نشود،
        هیچ فایلی به درخواست اضافه نمی‌شود.
      </p>
      <ul className="grid grid-cols-3 gap-3" role="listbox" aria-label="گالری خصوصی">
        {media.map((item) => {
          const selected = item.id === selectedId;
          const caption = item.label ?? "فایل بدون نام";
          // Destructured so the check below narrows the type for the <img>.
          const { signedUrl } = item;
          return (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(item)}
                className={`w-full overflow-hidden rounded-xl text-right transition-all ${
                  selected
                    ? "neu-pressed-pink"
                    : "neu-raised neu-interactive"
                }`}
              >
                <span className="flex aspect-square items-center justify-center bg-soft-border/20">
                  {signedUrl !== null && item.isImage ? (
                    /* Signed URLs are short-lived; the image optimizer
                       would cache them. */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={signedUrl}
                      alt={caption}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="px-2 text-center text-[11px] text-text-dark/50">
                      بدون پیش‌نمایش
                    </span>
                  )}
                </span>
                <span className="block truncate px-2 py-1 text-[11px] text-text-dark" title={caption}>
                  {caption}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {moreFailed && (
        <p className="text-sm text-coral" role="alert">
          بارگذاری فایل‌های بیشتر ناموفق بود. دوباره تلاش کنید.
        </p>
      )}
      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          aria-busy={loadingMore}
          className="text-sm font-medium text-candy-pink hover:opacity-80 disabled:opacity-50"
        >
          {loadingMore ? "در حال بارگذاری…" : "نمایش فایل‌های بیشتر"}
        </button>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="text-sm font-medium text-candy-pink hover:opacity-80"
      >
        بارگذاری فایل جدید به‌جای انتخاب از گالری
      </button>
    </div>
  );
}

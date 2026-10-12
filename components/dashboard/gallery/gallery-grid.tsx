"use client";

import { useState } from "react";
import { Button } from "@/components/ui/neu-button";
import { GalleryMediaCard } from "@/components/dashboard/gallery/gallery-media-card";
import { appendUniqueById } from "@/lib/parent/gallery/pagination";
import type { ParentGalleryMedia } from "@/lib/parent/gallery/types";

/**
 * First page arrives server-rendered; "load more" fetches the following pages
 * from the same bounded API the reuse picker uses. Results are appended
 * without duplicates and the button is disabled while a page is in flight.
 */
export function GalleryGrid({
  initialMedia,
  initialCursor,
}: {
  initialMedia: ParentGalleryMedia[];
  initialCursor: string | null;
}) {
  const [media, setMedia] = useState(initialMedia);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
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
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {media.map((item) => (
          <GalleryMediaCard key={item.id} media={item} />
        ))}
      </div>
      {failed && (
        <p className="mt-4 text-center text-sm text-coral" role="alert">
          بارگذاری فایل‌های بیشتر ناموفق بود. دوباره تلاش کنید.
        </p>
      )}
      {cursor && (
        <div className="mt-6 text-center">
          <Button variant="secondary" onClick={loadMore} disabled={loading} aria-busy={loading}>
            {loading ? "در حال بارگذاری…" : "نمایش فایل‌های بیشتر"}
          </Button>
        </div>
      )}
    </>
  );
}

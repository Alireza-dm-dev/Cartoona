import type { ParentGalleryMedia } from "@/lib/parent/gallery/types";

/**
 * Persian-Gregorian date, formatted for display only. The read model carries
 * ISO strings so formatting stays a UI concern.
 */
function formatUploadedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * One item in the parent's private source-media library.
 *
 * Three presentations, because a signed preview is not guaranteed: an image
 * with a working signature, a non-image source file, and an asset whose
 * signature could not be produced — the object may have been removed, or
 * signing may have failed. The last case says only that the preview is
 * unavailable: the storage and backend reasons are not the parent's problem
 * and would be a leak if shown.
 */
export function GalleryMediaCard({ media }: { media: ParentGalleryMedia }) {
  // Destructured so the null check below narrows the type for the <img>.
  const { signedUrl, isImage } = media;
  const caption = media.label ?? "فایل بدون نام";

  return (
    <figure className="neu-raised overflow-hidden rounded-xl">
      <div className="flex aspect-square items-center justify-center bg-soft-border/20">
        {signedUrl === null ? (
          <span className="px-3 text-center text-xs text-text-dark/50">
            پیش‌نمایش این فایل در دسترس نیست
          </span>
        ) : isImage ? (
          /* Signed URLs are short-lived and host-varying; the image
             optimizer would cache them. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={signedUrl}
            alt={caption}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="text-3xl" aria-hidden="true">
            📄
          </span>
        )}
      </div>
      <figcaption className="px-3 py-2">
        <p className="truncate text-xs font-medium text-text-dark" title={caption}>
          {caption}
        </p>
        <p className="mt-0.5 text-[11px] text-text-dark/50">
          {formatUploadedAt(media.uploadedAt)}
        </p>
      </figcaption>
    </figure>
  );
}

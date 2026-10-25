/**
 * The parent's private source-media library.
 *
 * This is the *source* media a parent uploaded for a creation request — the
 * child photo, the reference image, the drawing. It is deliberately not the
 * delivered output: final and preview assets are a separate `asset_role` and
 * belong to the order detail page, not to this library.
 */
export interface ParentGalleryMedia {
  /** `media_assets.id`. The only identifier the browser ever sees. */
  id: string;
  mimeType: string | null;
  uploadedAt: string;
  /**
   * Short-lived signed preview URL. Null when signing failed or the object is
   * gone, so the card degrades to an "unavailable" tile instead of a broken
   * image. Never persisted.
   */
  signedUrl: string | null;
  isImage: boolean;
  /**
   * Parent-facing file name, when one was recorded. Never the storage path —
   * the path stays server-side and is not part of this model.
   */
  label: string | null;
}

export type ParentGalleryResult =
  | {
      ok: true;
      media: ParentGalleryMedia[];
      /** Opaque cursor for the next page, or null when this is the last one. */
      nextCursor: string | null;
    }
  | {
      ok: false;
      reason: "unauthenticated" | "no_parent_profile" | "read_failed" | "invalid_cursor" | "forbidden";
    };

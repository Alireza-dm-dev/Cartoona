import appBackground from "@/assets/non-homepage/app-background.webp";

/**
 * Shared application background for every non-homepage surface.
 *
 * Uses a dedicated desert/pastel illustration as a fixed, full-viewport layer
 * behind page content, with a translucent cream wash on top for text
 * readability (see `.app-bg-layer` in globals.css, which also owns the crop:
 * `object-position: center`, and `center 65%` at <=640px). It is a plain, static
 * element (no hooks, no client JS) so it adds no client bundle weight.
 *
 * Delivery (V0.1.33):
 *  - The artwork is a 2528x1696 WebP (~90 KB; the original PNG was 3.2 MB at
 *    near-identical quality - PSNR ~45 dB on a flat pastel illustration).
 *  - It is STATICALLY IMPORTED rather than referenced from /public. Next then
 *    emits it as /_next/static/media/app-background.<content-hash>.webp, which
 *    is served `Cache-Control: public, max-age=31536000, immutable`. Files under
 *    /public get `max-age=0` and revalidate on every load. Because the URL
 *    changes whenever the pixels change, long-lived caching cannot go stale.
 *  - One file for every viewport: on phones `cover` shows only ~30% of the
 *    width but the FULL height, so a width-reduced mobile variant would be
 *    blurrier exactly where it is looked at, to save ~30 KB. Not worth a second
 *    asset or a <picture> switch.
 *  - Not preloaded: it is an ordinary <img> in server-rendered HTML, so the
 *    browser's preload scanner discovers it immediately, and at ~90 KB it does
 *    not compete with the page's real content. next/image is deliberately not
 *    used: the file is already optimized, and its runtime /_next/image
 *    optimizer would add server work for no gain.
 *  - width/height come from the import, so the browser knows the aspect ratio;
 *    the layer is position:fixed with the image at 100%x100%, so there is no
 *    layout shift.
 *
 * Deliberately NOT used by app/(marketing)/layout.tsx or app/(marketing)/page.tsx
 * (the homepage), which has its own frozen scroll-driven artwork mechanism in
 * HomepageArtworkStory.tsx and its own asset. This component must never be
 * rendered there.
 */
export function AppBackground() {
  return (
    <div className="app-bg-layer" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-optimized static asset in a fixed, CSS-cropped layer; next/image's runtime optimizer adds nothing here */}
      <img
        src={appBackground.src}
        width={appBackground.width}
        height={appBackground.height}
        alt=""
      />
    </div>
  );
}

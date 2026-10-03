/**
 * Shared application background for every non-homepage surface.
 *
 * Uses a dedicated desert/pastel illustration
 * (public/images/non-homepage/hf_20260927_192006_6eb8e260-ff89-410e-b638-960d6a5cc702.png,
 * separate from the homepage's own artwork file) as a fixed, full-viewport
 * layer behind page content, with a translucent cream wash on top for text
 * readability. It is a plain, static element (no hooks, no client JS) so it
 * adds no client bundle weight.
 *
 * Deliberately NOT used by app/(marketing)/layout.tsx or app/(marketing)/page.tsx
 * (the homepage), which has its own frozen scroll-driven artwork mechanism in
 * HomepageArtworkStory.tsx and its own asset (sections-bg.png). This component
 * must never be rendered there, and must never reference that asset.
 */
export function AppBackground() {
  return (
    <div className="app-bg-layer" aria-hidden="true">
      <img
        src="/images/non-homepage/hf_20260927_192006_6eb8e260-ff89-410e-b638-960d6a5cc702.png"
        alt=""
      />
    </div>
  );
}

/**
 * Shared application background for every non-homepage surface.
 *
 * Reuses the exact homepage artwork file (public/images/homepage/sections-bg.png)
 * as a fixed, full-viewport layer behind page content, with a translucent
 * cream wash on top for text readability. It is a plain, static element
 * (no hooks, no client JS) so it adds no client bundle weight.
 *
 * Deliberately NOT used by app/(marketing)/layout.tsx or app/(marketing)/page.tsx
 * (the homepage), which has its own frozen scroll-driven artwork mechanism in
 * HomepageArtworkStory.tsx. This component must never be rendered there.
 */
export function AppBackground() {
  return (
    <div className="app-bg-layer" aria-hidden="true">
      <img src="/images/homepage/sections-bg.png" alt="" />
    </div>
  );
}

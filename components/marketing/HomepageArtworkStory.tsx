"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { HorizontalStory } from "@/components/marketing/HorizontalStory";

interface HomepageArtworkStoryProps {
  /** Vertical content shown before the horizontal sequence starts. */
  intro: ReactNode;
  /** Panels the horizontal sequence pans across. */
  panels: ReactNode[];
}

export const SECTIONS_BG_SRC = "/images/homepage/sections-bg.png";

/**
 * How much wider than the viewport the artwork layer is drawn, as a fraction.
 * The surplus is the distance the artwork pans across during the horizontal
 * sequence - the backdrop drifts rather than racing the panels, which is what
 * makes the three panels read as three places in one world instead of three
 * separate backgrounds.
 */
const BG_OVERSCAN = 0.4;

/**
 * One illustrated canvas behind the vertical intro and the horizontal sequence.
 *
 * The artwork is a single sticky layer that the whole group scrolls past, so it
 * never restarts between sections, and no child paints its own opaque
 * background over it. During the horizontal sequence the layer pans in the same
 * rAF frame as the panels via HorizontalStory's onProgress hook, which writes
 * straight to the DOM and never touches React state.
 *
 * Everything visible in the artwork - including the red area - comes from the
 * PNG itself. Nothing here draws or tints it.
 */
export function HomepageArtworkStory({ intro, panels }: HomepageArtworkStoryProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  const panBackdrop = useCallback((progress: number) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    // RTL: the sequence advances leftwards through the artwork, so the layer
    // starts pulled left (showing its right edge) and settles at 0.
    const distance = backdrop.offsetWidth - (backdrop.parentElement?.clientWidth ?? 0);
    backdrop.style.transform = `translate3d(${(progress - 1) * distance}px,0,0)`;
  }, []);

  return (
    <div className="relative isolate">
      {/* Sticky artwork layer. The -mt-[100vh] on the content below lifts the
          group back over it, so this behaves like a backdrop pinned to the
          viewport for the whole story rather than a per-section background. */}
      <div
        aria-hidden="true"
        className="pointer-events-none sticky top-0 h-screen w-full overflow-hidden"
      >
        <div
          ref={backdropRef}
          // Anchored left and never translated past 0, so the oversized layer
          // covers the viewport at both ends of the pan instead of exposing the
          // page background at one edge.
          className="absolute inset-y-0 left-0 will-change-transform"
          style={{
            width: `${(1 + BG_OVERSCAN) * 100}%`,
            backgroundImage: `url(${SECTIONS_BG_SRC})`,
            // `cover` on an oversized box keeps the artwork's aspect ratio
            // intact - it is never stretched to fit.
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }}
        />
      </div>

      <div className="relative -mt-[100vh]">
        {intro}
        <HorizontalStory panels={panels} onProgress={panBackdrop} />
      </div>
    </div>
  );
}

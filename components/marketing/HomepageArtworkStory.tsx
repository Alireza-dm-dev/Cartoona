"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { HorizontalStory } from "@/components/marketing/HorizontalStory";

interface HomepageArtworkStoryProps {
  /** Vertical content shown before the horizontal sequence starts. */
  intro: ReactNode;
  /** Panels the horizontal sequence pans across. */
  panels: ReactNode[];
  /** Vertical content after the sequence, which stays on the same artwork. */
  outro: ReactNode;
}

export const SECTIONS_BG_SRC = "/images/homepage/sections-bg.png";

/**
 * The artwork layer is drawn this much taller than the viewport and anchored to
 * its bottom edge, so only the lower ~63% of the canvas is ever on screen.
 *
 * That crop is what keeps the television out of the sections background: the TV
 * lives in the top-left of the artwork and its screen ends at 23.9% down, well
 * above the 1/1.6 = 37.5% mark where this window starts. The TV belongs to the
 * hero, and a second dead black screen drifting through the sections would read
 * as an artifact. Cropping rather than masking keeps the rest of the artwork
 * exactly as drawn.
 */
const BG_CROP_CLASS = "h-[160%]";

/**
 * One illustrated canvas behind every section after the hero.
 *
 * The artwork is a single sticky layer that the whole group scrolls past, so it
 * never restarts, resets, or detaches between sections - it stays put from the
 * first section after the hero through the last one on the page. During the
 * horizontal sequence it pans in the same rAF frame as the panels via
 * HorizontalStory's onProgress hook, which writes straight to the DOM and never
 * touches React state; once the sequence ends the layer simply holds its final
 * position for the remaining vertical sections.
 */
export function HomepageArtworkStory({ intro, panels, outro }: HomepageArtworkStoryProps) {
  const backdropRef = useRef<HTMLImageElement>(null);

  /** Distance the artwork can travel before exposing an edge. */
  const panDistance = () => {
    const backdrop = backdropRef.current;
    const frame = backdrop?.parentElement;
    if (!backdrop || !frame) return 0;
    return Math.max(0, backdrop.offsetWidth - frame.clientWidth);
  };

  const panBackdrop = useCallback((progress: number) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    // RTL: the sequence advances leftwards through the artwork, so the layer
    // starts pulled left (showing its right edge) and settles at 0.
    backdrop.style.transform = `translate3d(${(progress - 1) * panDistance()}px,0,0)`;
  }, []);

  // Park the layer at its start offset before any scrolling happens, and keep it
  // there across resizes when the horizontal sequence is not running (mobile,
  // reduced motion), where nothing else would position it.
  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const settle = () => {
      if (!backdrop.style.transform) {
        backdrop.style.transform = `translate3d(${-panDistance()}px,0,0)`;
      }
    };
    if (backdrop.complete) settle();
    else backdrop.addEventListener("load", settle, { once: true });
    return () => backdrop.removeEventListener("load", settle);
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
        <img
          ref={backdropRef}
          src={SECTIONS_BG_SRC}
          alt=""
          // Height-driven sizing with `w-auto` keeps the artwork's aspect ratio
          // exactly - it is never stretched. `min-w-full` is the safety net for
          // very wide, short viewports, where object-cover crops instead of
          // distorting; `object-bottom` keeps that crop below the television.
          className={`absolute bottom-0 left-0 ${BG_CROP_CLASS} w-auto min-w-full max-w-none object-cover object-bottom will-change-transform`}
        />
      </div>

      <div className="relative -mt-[100vh]">
        {intro}
        <HorizontalStory panels={panels} onProgress={panBackdrop} />
        {outro}
      </div>
    </div>
  );
}

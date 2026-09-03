"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useHorizontalStoryEnabled } from "@/components/marketing/useHorizontalStoryEnabled";

interface HorizontalStoryProps {
  panels: ReactNode[];
  /**
   * Called with 0..1 from inside the scroll rAF frame so a shared backdrop can
   * pan in step with the panels. It MUST NOT set React state - write straight to
   * the DOM. Called once more on teardown-free re-enable so the backdrop can
   * resync after a resize.
   */
  onProgress?: (progress: number) => void;
}

/**
 * Turns vertical page scroll through a tall track into horizontal movement
 * across `panels`, then hands scrolling back to the page.
 *
 * The track is `100vh + (panels-1) * PANEL_TRAVEL_VW` tall. Its first viewport
 * pins via `position: sticky`, and the panel row is translated by the fraction
 * of the track that has scrolled past. Nothing hijacks the wheel, nothing calls
 * scrollTo, and there is no nested scroller - the page scrollbar stays the one
 * source of truth, so scrolling back up reverses the pan for free.
 *
 * Below `lg`, and whenever reduced motion is requested, the panels render as
 * ordinary stacked sections instead.
 */

/**
 * Vertical scroll (in vw, so it stays proportional to the horizontal distance
 * actually travelled) spent moving from one panel to the next. Below 100 the
 * panels move faster than the finger; this is deliberately a little under 1:1 so
 * the sequence does not feel like an endless scroll.
 */
const PANEL_TRAVEL_VW = 80;

export function HorizontalStory({ panels, onProgress }: HorizontalStoryProps) {
  const enabled = useHorizontalStoryEnabled();
  const trackRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Held in a ref so changing the callback never re-subscribes the scroll loop.
  // Synced in its own effect (declared first, so it lands before the scroll
  // effect below runs) rather than during render.
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    const track = trackRef.current;
    const row = rowRef.current;
    if (!enabled || !track || !row) {
      // Fallback layout: make sure a previously-applied transform is cleared.
      if (row) row.style.transform = "";
      onProgressRef.current?.(0);
      return;
    }

    let rafId = 0;
    let running = false;
    let disposed = false;

    function apply() {
      running = false;
      if (disposed) return;
      const rect = track!.getBoundingClientRect();
      const viewport = window.innerHeight || document.documentElement.clientHeight;
      const travel = rect.height - viewport;
      const progress = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
      // The row is `panels.length` viewports wide; sliding it by the surplus
      // walks exactly from the first panel to the last.
      const distance = row!.scrollWidth - row!.clientWidth;
      // RTL: the row starts flush right, so advancing means moving it right.
      row!.style.transform = `translate3d(${progress * distance}px,0,0)`;
      onProgressRef.current?.(progress);
    }

    function schedule() {
      if (running || disposed) return;
      running = true;
      rafId = requestAnimationFrame(apply);
    }

    apply();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [enabled, panels.length]);

  if (!enabled) {
    return (
      <>
        {panels.map((panel, i) => (
          <section key={i} className="py-16 md:py-24">
            {panel}
          </section>
        ))}
      </>
    );
  }

  const trackHeight = `calc(100vh + ${(panels.length - 1) * PANEL_TRAVEL_VW}vw)`;

  return (
    <div ref={trackRef} className="relative" style={{ height: trackHeight }}>
      <div className="sticky top-0 h-screen overflow-hidden">
        <div
          ref={rowRef}
          className="flex h-full will-change-transform"
          // No CSS transition: the transform is already driven frame-by-frame by
          // scroll position, and easing it would lag the finger.
        >
          {panels.map((panel, i) => (
            // No nested scroller here on purpose: the panel is sized to the
            // pinned viewport and its content is centred within it.
            <section
              key={i}
              className="flex h-full items-center overflow-hidden py-8"
              style={{ flex: "0 0 100vw" }}
            >
              <div className="max-h-full w-full">{panel}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

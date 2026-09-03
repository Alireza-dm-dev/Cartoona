"use client";

import { useEffect, useRef, type RefObject } from "react";

interface ScrollScrubVideoProps {
  src: string;
  /**
   * Element whose scroll travel (its own height minus one viewport) maps onto
   * the video's full duration.
   */
  trackRef: RefObject<HTMLElement | null>;
  className?: string;
}

/** Below this delta (seconds) the playhead is considered settled. */
const SETTLE_EPSILON = 1 / 60;
/** Per-frame easing toward the scroll target; keeps fast flicks from snapping. */
const EASING = 0.18;
/**
 * Minimum scroll travel, as a fraction of the viewport, before scrubbing engages.
 * The track only gets real travel where the hero is pinned; in the stacked mobile
 * layout it clears the viewport by a few dozen pixels, which would otherwise burn
 * the whole clip in one flick. Below this the video just holds its first frame.
 */
const MIN_TRAVEL_RATIO = 0.5;

/**
 * A video whose playhead is driven by scroll position instead of playback.
 *
 * The video never plays or loops on its own: `currentTime` is eased toward the
 * scroll-derived target inside a single self-terminating rAF loop, so scrolling
 * down advances it, scrolling up rewinds it, and stopping freezes it. Nothing
 * here touches React state, and the loop parks itself once the playhead settles.
 */
export function ScrollScrubVideo({ src, trackRef, className }: ScrollScrubVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const track = trackRef.current;
    if (!video || !track) return;

    video.pause();

    let duration = 0;
    let target = 0;
    let rafId = 0;
    let running = false;
    let disposed = false;

    function readTarget() {
      if (!duration) return;
      const rect = track!.getBoundingClientRect();
      const viewport = window.innerHeight || document.documentElement.clientHeight;
      const travel = rect.height - viewport;
      const progress =
        travel >= viewport * MIN_TRAVEL_RATIO
          ? Math.min(1, Math.max(0, -rect.top / travel))
          : 0;
      target = progress * duration;
    }

    function step() {
      running = false;
      if (disposed || !duration) return;
      const current = video!.currentTime;
      const delta = target - current;
      if (Math.abs(delta) < SETTLE_EPSILON) {
        // Land exactly on target so repeated settles don't drift.
        if (delta !== 0 && !video!.seeking) video!.currentTime = target;
        return;
      }
      if (!video!.seeking) video!.currentTime = current + delta * EASING;
      schedule();
    }

    function schedule() {
      if (running || disposed) return;
      running = true;
      rafId = requestAnimationFrame(step);
    }

    function onScroll() {
      readTarget();
      schedule();
    }

    function onMetadata() {
      duration = Number.isFinite(video!.duration) ? video!.duration : 0;
      readTarget();
      // Jump straight to the scroll-derived frame on first load instead of
      // easing in from zero.
      if (duration && !video!.seeking) video!.currentTime = target;
    }

    if (video.readyState >= 1) onMetadata();
    else video.addEventListener("loadedmetadata", onMetadata);

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      video.removeEventListener("loadedmetadata", onMetadata);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [trackRef]);

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      playsInline
      preload="auto"
      // Explicitly not autoPlay / not loop: scroll owns the playhead.
      aria-hidden="true"
      className={className}
    />
  );
}

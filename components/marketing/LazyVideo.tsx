"use client";

import { useEffect, useRef, useState } from "react";

interface LazyVideoProps {
  src: string;
  /** First frame, shown until the video plays. */
  poster?: string;
  className?: string;
  /**
   * Also wait for the window `load` event, so an on-screen video does not
   * compete with the page's own images (the hero) for bandwidth.
   */
  afterLoad?: boolean;
}

/**
 * A muted, looping, inline video that downloads NOTHING until it is near the
 * viewport (and, with `afterLoad`, until the page has loaded). Once started it
 * plays while visible and pauses while scrolled away, matching what browsers
 * do for the previous `autoPlay muted loop playsInline` element.
 *
 * `preload="none"` plus no `src` before activation is what actually defers the
 * download: with `autoPlay` set, browsers ignore `preload="metadata"`.
 */
export function LazyVideo({ src, poster, className, afterLoad = false }: LazyVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const visible = useRef(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let removeLoadListener = () => {};
    let requested = false;

    const activate = () => {
      if (cancelled || requested) return;
      requested = true;
      if (afterLoad && document.readyState !== "complete") {
        const onLoad = () => !cancelled && setActive(true);
        window.addEventListener("load", onLoad, { once: true });
        removeLoadListener = () => window.removeEventListener("load", onLoad);
        return;
      }
      setActive(true);
    };

    if (typeof IntersectionObserver === "undefined") {
      visible.current = true;
      activate();
      return () => {
        cancelled = true;
        removeLoadListener();
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some((entry) => entry.isIntersecting);
        visible.current = isVisible;
        if (isVisible) activate();
        // Already started: follow visibility (pause off-screen, resume on return).
        if (el.currentSrc) {
          if (isVisible) el.play().catch(() => {});
          else el.pause();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      removeLoadListener();
    };
  }, [afterLoad]);

  useEffect(() => {
    const el = ref.current;
    if (!active || !el || !visible.current) return;
    el.muted = true;
    // Muted inline playback is allowed without a gesture; a refusal (e.g. data
    // saver) just leaves the poster visible, as before.
    el.play().catch(() => {});
  }, [active, src]);

  return (
    <video
      ref={ref}
      src={active ? src : undefined}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      className={className}
    />
  );
}

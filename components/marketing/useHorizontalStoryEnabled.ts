"use client";

import { useSyncExternalStore } from "react";

/**
 * The horizontal story only runs on a wide, motion-tolerant viewport. Narrow
 * screens fall back to plain stacked sections (a pinned 100vw panel row is
 * cramped and easy to get stuck in on touch), and so does anyone asking for
 * reduced motion.
 */
const ENABLED_QUERY = "(min-width: 1024px) and (prefers-reduced-motion: no-preference)";

function subscribe(callback: () => void) {
  const query = window.matchMedia(ENABLED_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.matchMedia(ENABLED_QUERY).matches;
}

/**
 * Server and first client paint both assume "off", so the markup React hydrates
 * against always matches; the wide-viewport layout is swapped in immediately
 * afterwards. Guessing "on" here would risk a hydration mismatch on mobile.
 */
function getServerSnapshot() {
  return false;
}

export function useHorizontalStoryEnabled() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

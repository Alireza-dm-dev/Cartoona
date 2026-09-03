"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ScrollScrubVideo } from "@/components/marketing/ScrollScrubVideo";

const NAV_LINKS = [
  { href: "/characters", label: "شخصیت‌ها" },
  { href: "/examples", label: "نمونه‌ها" },
  { href: "/pricing", label: "قیمت‌گذاری" },
  { href: "/safety", label: "ایمنی و حریم خصوصی" },
  { href: "/faq", label: "سوالات متداول" },
];

const HERO_VIDEO_SRC = "/videos/homepage/hero.mp4";
// Intrinsic dimensions of hero.mp4, needed to compute where its object-fit:cover
// crop actually lands so the TV overlay can be aligned against the real video
// content rather than the (differently-shaped) frame box.
const HERO_VIDEO_INTRINSIC = { width: 1108, height: 828 };

// The clip authored for the TV screen. Its 966x754 frame is a near-match for the
// screen cutout's 1.32 aspect, so object-cover crops almost nothing.
const TV_SCREEN_CONTENT_SRC = "/videos/homepage/hero-tv.mp4";

// Fraction of the hero video's own (cropped) frame occupied by the TV screen
// cutout. Measured off the black cutout baked into hero.mp4 rather than eyeballed:
// the cutout holds this rect to within ~0.5% across all 73 frames, so one fixed
// fraction stays registered for the whole scrub.
const TV_SCREEN_RECT = { left: 0.334, top: 0.434, width: 0.289, height: 0.293 };

// Scroll travel the pinned hero scrubs across before the next section takes over,
// as a literal class so Tailwind's scanner can see it. Only applies from `md` up,
// where the hero is a pinned full viewport; the extra 120vh past the pinned
// viewport is the distance that maps onto the video's full duration.
const HERO_SCRUB_TRACK_CLASS = "md:h-[220vh]";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(callback: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function getReducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot() {
  return false;
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );
}

/**
 * Where an `object-fit: cover` video actually lands inside `containerRef`, in
 * container-relative px. Lets the TV overlay be placed against the video's real
 * content box instead of the frame, which is what keeps it registered when the
 * frame's aspect ratio differs from the video's.
 */
function useCoverRect(
  containerRef: RefObject<HTMLElement | null>,
  mediaWidth: number,
  mediaHeight: number
) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function measure() {
      const { width: containerWidth, height: containerHeight } = el!.getBoundingClientRect();
      if (!containerWidth || !containerHeight) return;
      const scale = Math.max(containerWidth / mediaWidth, containerHeight / mediaHeight);
      const renderedWidth = mediaWidth * scale;
      const renderedHeight = mediaHeight * scale;
      setRect({
        left: (containerWidth - renderedWidth) / 2,
        top: (containerHeight - renderedHeight) / 2,
        width: renderedWidth,
        height: renderedHeight,
      });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, mediaWidth, mediaHeight]);

  return rect;
}

/** Reduced-motion stand-in: the hero video parked on a single stable frame. */
function StaticHeroFrame({ src, className }: { src: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const showFirstFrame = () => {
      video.currentTime = 0;
    };
    if (video.readyState >= 1) showFirstFrame();
    else video.addEventListener("loadedmetadata", showFirstFrame, { once: true });

    return () => video.removeEventListener("loadedmetadata", showFirstFrame);
  }, []);

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      className={className}
    />
  );
}

/**
 * The looping clip that plays inside the TV. Sized and placed as a percentage of
 * the hero video's rendered content box, so it stays inside the bezel at every
 * width without any fixed desktop pixel coordinates.
 */
function TvScreenOverlay({ frameRef }: { frameRef: RefObject<HTMLDivElement | null> }) {
  const coverRect = useCoverRect(frameRef, HERO_VIDEO_INTRINSIC.width, HERO_VIDEO_INTRINSIC.height);
  if (!coverRect) return null;

  const left = coverRect.left + TV_SCREEN_RECT.left * coverRect.width;
  const top = coverRect.top + TV_SCREEN_RECT.top * coverRect.height;
  const width = TV_SCREEN_RECT.width * coverRect.width;
  const height = TV_SCREEN_RECT.height * coverRect.height;

  return (
    <div
      className="pointer-events-none absolute overflow-hidden"
      style={{ left, top, width, height, borderRadius: Math.max(4, width * 0.05) }}
      aria-hidden="true"
    >
      <video
        src={TV_SCREEN_CONTENT_SRC}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        className="h-full w-full object-cover"
      />
    </div>
  );
}

export function Hero() {
  const [menuOpen, setMenuOpen] = useState(false);
  const trackRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  // From `md` up the hero is a pinned viewport that the page scrolls "through",
  // which is what gives the scrub its travel. Below `md` the same content is a
  // plain stacked column: a landscape video cannot fill a portrait viewport
  // without cropping the TV off-screen, so it gets its own band instead.
  const trackClass = reducedMotion ? "" : HERO_SCRUB_TRACK_CLASS;
  const stageClass = reducedMotion ? "md:min-h-screen" : "md:sticky md:top-0 md:h-screen";

  return (
    <section ref={trackRef} className={`font-ui relative ${trackClass}`}>
      <div
        className={`relative flex w-full flex-col items-center overflow-hidden pt-[96px] pb-9 md:block md:p-0 ${stageClass}`}
        style={{ background: "linear-gradient(180deg,#cdeaf6 0%,#b6dced 34%,#dcdfe8 60%,#fbe8ee 100%)" }}
      >
        {/* Hero media. Full-bleed behind the composition on desktop; an in-flow
            band, wider than the viewport so the TV keeps a usable size, on mobile. */}
        <div className="order-2 mt-6 flex w-full justify-center md:absolute md:inset-0 md:order-none md:mt-0 md:block">
          <div
            ref={frameRef}
            className="hero-media-band relative aspect-[1108/828] w-[140%] shrink-0 md:h-full md:w-full"
          >
            {reducedMotion ? (
              <StaticHeroFrame
                src={HERO_VIDEO_SRC}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <ScrollScrubVideo
                src={HERO_VIDEO_SRC}
                trackRef={trackRef}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            <TvScreenOverlay frameRef={frameRef} />
          </div>
        </div>

        <nav className="absolute top-[clamp(12px,2.6vh,30px)] left-1/2 z-20 flex w-[min(1320px,92vw)] -translate-x-1/2 items-center justify-between gap-4 rounded-full bg-white/78 px-4 py-2.5 shadow-[0_6px_22px_rgba(80,120,150,0.16)] backdrop-blur-md sm:px-6 sm:py-3">
          <Link
            href="/"
            className="shrink-0 text-xl font-extrabold leading-none text-candy-pink sm:text-2xl"
          >
            کارتونا
          </Link>

          <div className="hidden items-center gap-6 whitespace-nowrap text-[15px] leading-normal font-bold text-parent-navy md:flex">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="hover:text-candy-pink transition-colors">
                {link.label}
              </Link>
            ))}
          </div>

          <div className="hidden shrink-0 items-center gap-4 md:flex">
            <Link
              href="/login"
              className="text-[15px] leading-normal font-bold text-parent-navy hover:text-candy-pink transition-colors"
            >
              ورود
            </Link>
            <Link href="/signup">
              <Button
                size="sm"
                className="rounded-full px-5 py-2 text-[15px] font-bold shadow-[0_6px_16px_rgba(242,100,154,0.35)]"
              >
                شروع کنید
              </Button>
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-2.5 md:hidden">
            <Link href="/signup">
              <Button
                size="sm"
                className="rounded-full px-4 py-2 text-sm font-bold shadow-[0_6px_16px_rgba(242,100,154,0.35)]"
              >
                شروع کنید
              </Button>
            </Link>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="منو"
              aria-expanded={menuOpen}
              className="flex h-11 w-11 flex-col items-center justify-center gap-1 rounded-2xl bg-white shadow-[0_4px_12px_rgba(80,120,150,0.18)]"
            >
              <span className="h-0.5 w-[18px] rounded-full bg-parent-navy" />
              <span className="h-0.5 w-[18px] rounded-full bg-parent-navy" />
              <span className="h-0.5 w-[18px] rounded-full bg-parent-navy" />
            </button>
          </div>
        </nav>

        {menuOpen && (
          <div className="absolute top-[calc(clamp(12px,2.6vh,30px)+74px)] left-1/2 z-20 flex w-[min(560px,92vw)] -translate-x-1/2 flex-col gap-1 rounded-[22px] bg-white/96 p-3.5 shadow-[0_14px_34px_rgba(80,120,150,0.2)] backdrop-blur-md md:hidden">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-2xl px-4 py-3.5 text-base font-semibold text-parent-navy hover:bg-candy-pink/10 hover:text-candy-pink transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setMenuOpen(false)}
              className="rounded-2xl px-4 py-3.5 text-base font-semibold text-candy-pink hover:bg-candy-pink/10 transition-colors"
            >
              ورود
            </Link>
          </div>
        )}

        <div className="order-1 z-10 flex w-[92vw] flex-col items-center gap-2 text-center md:absolute md:top-[clamp(88px,14vh,170px)] md:left-1/2 md:order-none md:w-[min(900px,90vw)] md:-translate-x-1/2 md:gap-[clamp(6px,1.1vh,14px)]">
          <span className="text-sm font-bold text-candy-pink sm:text-base">
            استودیوی خصوصی ساخت کارتون برای خانواده‌ها
          </span>
          <h1 className="text-[28px] font-bold leading-snug tracking-tight text-parent-navy text-balance sm:text-[43px] sm:leading-[1.35]">
            خاطره‌های کارتونی جادویی بسازید
          </h1>
          <p className="max-w-[380px] text-[15px] font-medium leading-[1.9] text-[#3f4859] text-pretty sm:max-w-[680px] sm:text-[17px] sm:leading-[1.95]">
            با کارتونا، والدین می‌توانند برای کودک خود تصویر، ویدئو یا انیمیشن
            کارتونی اختصاصی سفارش دهند؛ امن، خصوصی و کاملاً تحت کنترل والدین.
          </p>
        </div>

        <div className="order-3 z-10 mt-7 flex w-[92vw] flex-wrap items-center justify-center gap-3 md:absolute md:bottom-[clamp(52px,8vh,96px)] md:left-1/2 md:order-none md:mt-0 md:w-[min(760px,92vw)] md:-translate-x-1/2">
          <Link href="#creation-types">
            <Button size="lg" className="shadow-[0_10px_24px_rgba(242,100,154,0.35)]">
              شروع ساخت کارتون
            </Button>
          </Link>
          <Link href="/examples">
            <Button variant="secondary" size="lg" className="shadow-[0_10px_24px_rgba(80,120,150,0.18)]">
              مشاهده نمونه‌ها
            </Button>
          </Link>
        </div>

        <p className="order-4 z-10 mt-4 w-[92vw] text-center text-[13px] font-semibold text-[#4a5266] sm:text-sm md:absolute md:bottom-[clamp(20px,3.4vh,40px)] md:left-1/2 md:order-none md:mt-0 md:w-[min(760px,92vw)] md:-translate-x-1/2">
          تحت کنترل والدین · خصوصی برای خانواده · بدون اشتراک‌گذاری عمومی
        </p>
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { HeroTvRect } from "@/lib/homepage/hero-layout";
import type { HeroContent, NavigationContent } from "@/lib/homepage/types";

/**
 * Navigation routes are structural product routing and stay fixed in code. Only
 * the label of each is admin-editable, so an editor can rename a destination but
 * never repoint it.
 */
const NAV_ROUTES = [
  { key: "characters", href: "/characters", label: "charactersLabel" },
  { key: "examples", href: "/examples", label: "examplesLabel" },
  { key: "pricing", href: "/pricing", label: "pricingLabel" },
  { key: "safety", href: "/safety", label: "safetyLabel" },
  { key: "faq", href: "/faq", label: "faqLabel" },
] as const satisfies readonly {
  key: string;
  href: string;
  label: keyof NavigationContent;
}[];

/**
 * The hero backdrop is the homepage artwork itself, which already contains the
 * television. There is no hero background video any more: the only moving image
 * in the hero is the clip playing on the TV screen. Both files arrive as
 * resolved media props - the committed local fallbacks live in the resolver.
 *
 * The intrinsic size stays here because the crop maths is code-owned: the TV
 * cutout is a solid dark rect at x 215..400, y 218..364 of 2048x1529.
 */
const HERO_IMAGE_INTRINSIC = { width: 2048, height: 1529 };

/**
 * The artwork draws the TV small and up in the top-left corner, so the hero
 * frames a window onto it rather than showing the whole canvas: the image is
 * drawn `HERO_ZOOM` times the frame width and slid so the TV screen's centre
 * lands at HERO_TV_FOCUS.
 *
 * Desktop frames the full viewport. Mobile frames a shorter in-flow band that
 * sits between the copy and the CTAs, so it needs a tighter crop to give the
 * television a usable size in a narrow column.
 */
const HERO_ZOOM = { desktop: 2.62, mobile: 6.5 };
const HERO_TV_FOCUS = { desktop: { x: 0.5, y: 0.585 }, mobile: { x: 0.5, y: 0.5 } };

const MOBILE_QUERY = "(max-width: 767px)";

/** Geometry of the artwork inside the hero frame, plus where the TV lands in it. */
interface HeroFrameGeometry {
  imageLeft: number;
  imageTop: number;
  imageWidth: number;
  imageHeight: number;
  tv: { left: number; top: number; width: number; height: number };
}

function computeGeometry(
  frameWidth: number,
  frameHeight: number,
  isMobile: boolean,
  tvRect: HeroTvRect
): HeroFrameGeometry {
  const zoom = isMobile ? HERO_ZOOM.mobile : HERO_ZOOM.desktop;
  const focus = isMobile ? HERO_TV_FOCUS.mobile : HERO_TV_FOCUS.desktop;

  const imageWidth = frameWidth * zoom;
  const imageHeight =
    imageWidth * (HERO_IMAGE_INTRINSIC.height / HERO_IMAGE_INTRINSIC.width);

  const tvCentreX = tvRect.x + tvRect.width / 2;
  const tvCentreY = tvRect.y + tvRect.height / 2;

  // Slide the artwork so the TV lands on the focal point, then clamp so the
  // frame is never left showing past an edge of the image.
  const rawLeft = focus.x * frameWidth - tvCentreX * imageWidth;
  const rawTop = focus.y * frameHeight - tvCentreY * imageHeight;
  const imageLeft = Math.min(0, Math.max(frameWidth - imageWidth, rawLeft));
  const imageTop = Math.min(0, Math.max(frameHeight - imageHeight, rawTop));

  return {
    imageLeft,
    imageTop,
    imageWidth,
    imageHeight,
    tv: {
      left: imageLeft + tvRect.x * imageWidth,
      top: imageTop + tvRect.y * imageHeight,
      width: tvRect.width * imageWidth,
      height: tvRect.height * imageHeight,
    },
  };
}

/** Measures the hero frame and recomputes the artwork/TV geometry on resize. */
function useHeroGeometry(frameRef: RefObject<HTMLDivElement | null>, tvRect: HeroTvRect) {
  const [geometry, setGeometry] = useState<HeroFrameGeometry | null>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const mobileQuery = window.matchMedia(MOBILE_QUERY);

    function measure() {
      const { width, height } = el!.getBoundingClientRect();
      if (!width || !height) return;
      setGeometry(computeGeometry(width, height, mobileQuery.matches, tvRect));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    mobileQuery.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      mobileQuery.removeEventListener("change", measure);
    };
  }, [frameRef, tvRect]);

  return geometry;
}

interface HeroMedia {
  background: string;
  tv_video: string;
}

interface HeroLayout {
  rect: HeroTvRect;
}

export interface HeroProps {
  content: HeroContent;
  navigation: NavigationContent;
  media: HeroMedia;
  layout: HeroLayout;
}

/**
 * The hero renders entirely from resolved props. Choosing between a stored rect
 * and the default already happened in the resolver, so there is exactly one
 * place that decision lives and the component simply uses what it is handed.
 */
export function Hero({ content, navigation, media, layout }: HeroProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const geometry = useHeroGeometry(frameRef, layout.rect);

  return (
    <section className="font-ui relative">
      <div
        className="relative flex min-h-screen w-full flex-col items-center overflow-hidden pt-[96px] pb-9 md:block md:p-0"
        // Only seen below `md`, around the in-flow media band; from `md` up the
        // artwork covers the stage completely. Stops sampled from the artwork so
        // the band's feathered edges have something to blend into.
        style={{ background: "linear-gradient(180deg,#cfe7f1 0%,#e0e0f0 45%,#fbe8ee 100%)" }}
      >
        {/* Hero backdrop: the artwork, framed on the television it contains.
            Full-bleed behind the composition from `md` up; below that it takes
            an in-flow band between the copy and the CTAs, because a viewport-tall
            crop tight enough to make the TV readable on a phone would push it
            straight under the heading. */}
        <div className="order-2 mt-6 w-full md:absolute md:inset-0 md:mt-0">
          <div
            ref={frameRef}
            className="hero-media-band relative h-[clamp(230px,40vh,330px)] w-full overflow-hidden md:h-full"
            aria-hidden="true"
          >
            {geometry && (
              <>
                <img
                  src={media.background}
                  alt=""
                  className="absolute max-w-none"
                  style={{
                    left: geometry.imageLeft,
                    top: geometry.imageTop,
                    width: geometry.imageWidth,
                    height: geometry.imageHeight,
                  }}
                />
                {/* The TV screen. Video only - no copy or controls sit over it. */}
                <div
                  className="pointer-events-none absolute overflow-hidden"
                  style={{
                    left: geometry.tv.left,
                    top: geometry.tv.top,
                    width: geometry.tv.width,
                    height: geometry.tv.height,
                    borderRadius: Math.max(4, geometry.tv.width * 0.045),
                  }}
                >
                  <video
                    src={media.tv_video}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="auto"
                    className="h-full w-full object-cover"
                  />
                </div>
              </>
            )}
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
            {NAV_ROUTES.map((route) => (
              <Link key={route.href} href={route.href} className="hover:text-candy-pink transition-colors">
                {navigation[route.label]}
              </Link>
            ))}
          </div>

          <div className="hidden shrink-0 items-center gap-4 md:flex">
            <Link
              href="/login"
              className="text-[15px] leading-normal font-bold text-parent-navy hover:text-candy-pink transition-colors"
            >
              {navigation.loginLabel}
            </Link>
            <Link href="/signup">
              <Button
                size="sm"
                className="rounded-full px-5 py-2 text-[15px] font-bold shadow-[0_6px_16px_rgba(242,100,154,0.35)]"
              >
                {navigation.signupLabel}
              </Button>
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-2.5 md:hidden">
            <Link href="/signup">
              <Button
                size="sm"
                className="rounded-full px-4 py-2 text-sm font-bold shadow-[0_6px_16px_rgba(242,100,154,0.35)]"
              >
                {navigation.signupLabel}
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
            {NAV_ROUTES.map((route) => (
              <Link
                key={route.href}
                href={route.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-2xl px-4 py-3.5 text-base font-semibold text-parent-navy hover:bg-candy-pink/10 hover:text-candy-pink transition-colors"
              >
                {navigation[route.label]}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setMenuOpen(false)}
              className="rounded-2xl px-4 py-3.5 text-base font-semibold text-parent-navy hover:bg-candy-pink/10 hover:text-candy-pink transition-colors"
            >
              {navigation.loginLabel}
            </Link>
          </div>
        )}

        <div className="order-1 z-10 flex w-[92vw] flex-col items-center gap-2 text-center md:absolute md:top-[clamp(88px,14vh,170px)] md:left-1/2 md:w-[min(900px,92vw)] md:-translate-x-1/2 md:gap-[clamp(6px,1.1vh,14px)]">
          <span className="text-sm font-bold text-candy-pink sm:text-base">
            {content.eyebrow}
          </span>
          <h1 className="text-[28px] font-bold leading-snug tracking-tight text-parent-navy text-balance sm:text-[43px] sm:leading-[1.35]">
            {content.title}
          </h1>
          <p className="max-w-[380px] text-[15px] font-medium leading-[1.9] text-[#3f4859] text-pretty sm:max-w-[680px] sm:text-[17px] sm:leading-[1.95]">
            {content.description}
          </p>
        </div>

        <div className="order-3 z-10 mt-7 flex w-[92vw] flex-wrap items-center justify-center gap-3 md:absolute md:bottom-[clamp(52px,8vh,96px)] md:left-1/2 md:mt-0 md:w-[min(760px,92vw)] md:-translate-x-1/2">
          <Link href="#creation-types">
            <Button size="lg" className="shadow-[0_10px_24px_rgba(242,100,154,0.35)]">
              {content.primaryCta.label}
            </Button>
          </Link>
          <Link href="/examples">
            <Button variant="secondary" size="lg" className="shadow-[0_10px_24px_rgba(80,120,150,0.18)]">
              {content.secondaryCta.label}
            </Button>
          </Link>
        </div>

        <p className="order-4 z-10 mt-4 w-[92vw] text-center text-[13px] font-semibold text-[#4a5266] sm:text-sm md:absolute md:bottom-[clamp(20px,3.4vh,40px)] md:left-1/2 md:mt-0 md:w-[min(760px,92vw)] md:-translate-x-1/2">
          {content.trustLine}
        </p>
      </div>
    </section>
  );
}
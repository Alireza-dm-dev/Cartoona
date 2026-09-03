"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const NAV_LINKS = [
  { href: "/characters", label: "شخصیت‌ها" },
  { href: "/examples", label: "نمونه‌ها" },
  { href: "/pricing", label: "قیمت‌گذاری" },
  { href: "/safety", label: "ایمنی و حریم خصوصی" },
  { href: "/faq", label: "سوالات متداول" },
];

/**
 * The hero backdrop is the homepage artwork itself, which already contains the
 * television. There is no hero background video any more: the only moving image
 * in the hero is the clip playing on the TV screen.
 */
const HERO_IMAGE_SRC = "/images/homepage/sections-bg.png";
const HERO_IMAGE_INTRINSIC = { width: 2048, height: 1529 };

const TV_SCREEN_CONTENT_SRC = "/videos/homepage/hero-tv.mp4";

/**
 * The television's black screen cutout, as a fraction of the artwork. Measured
 * off the PNG rather than eyeballed - the cutout is a solid dark rect at
 * x 215..400, y 218..364 of 2048x1529.
 */
const TV_SCREEN_RECT = { left: 0.1050, top: 0.1426, width: 0.0908, height: 0.0961 };

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
  isMobile: boolean
): HeroFrameGeometry {
  const zoom = isMobile ? HERO_ZOOM.mobile : HERO_ZOOM.desktop;
  const focus = isMobile ? HERO_TV_FOCUS.mobile : HERO_TV_FOCUS.desktop;

  const imageWidth = frameWidth * zoom;
  const imageHeight =
    imageWidth * (HERO_IMAGE_INTRINSIC.height / HERO_IMAGE_INTRINSIC.width);

  const tvCentreX = TV_SCREEN_RECT.left + TV_SCREEN_RECT.width / 2;
  const tvCentreY = TV_SCREEN_RECT.top + TV_SCREEN_RECT.height / 2;

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
      left: imageLeft + TV_SCREEN_RECT.left * imageWidth,
      top: imageTop + TV_SCREEN_RECT.top * imageHeight,
      width: TV_SCREEN_RECT.width * imageWidth,
      height: TV_SCREEN_RECT.height * imageHeight,
    },
  };
}

/** Measures the hero frame and recomputes the artwork/TV geometry on resize. */
function useHeroGeometry(frameRef: RefObject<HTMLDivElement | null>) {
  const [geometry, setGeometry] = useState<HeroFrameGeometry | null>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const mobileQuery = window.matchMedia(MOBILE_QUERY);

    function measure() {
      const { width, height } = el!.getBoundingClientRect();
      if (!width || !height) return;
      setGeometry(computeGeometry(width, height, mobileQuery.matches));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    mobileQuery.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      mobileQuery.removeEventListener("change", measure);
    };
  }, [frameRef]);

  return geometry;
}

export function Hero() {
  const [menuOpen, setMenuOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const geometry = useHeroGeometry(frameRef);

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
                  src={HERO_IMAGE_SRC}
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
                    src={TV_SCREEN_CONTENT_SRC}
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

        <div className="order-1 z-10 flex w-[92vw] flex-col items-center gap-2 text-center md:absolute md:top-[clamp(88px,14vh,170px)] md:left-1/2 md:w-[min(900px,90vw)] md:-translate-x-1/2 md:gap-[clamp(6px,1.1vh,14px)]">
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

        <div className="order-3 z-10 mt-7 flex w-[92vw] flex-wrap items-center justify-center gap-3 md:absolute md:bottom-[clamp(52px,8vh,96px)] md:left-1/2 md:mt-0 md:w-[min(760px,92vw)] md:-translate-x-1/2">
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

        <p className="order-4 z-10 mt-4 w-[92vw] text-center text-[13px] font-semibold text-[#4a5266] sm:text-sm md:absolute md:bottom-[clamp(20px,3.4vh,40px)] md:left-1/2 md:mt-0 md:w-[min(760px,92vw)] md:-translate-x-1/2">
          تحت کنترل والدین · خصوصی برای خانواده · بدون اشتراک‌گذاری عمومی
        </p>
      </div>
    </section>
  );
}

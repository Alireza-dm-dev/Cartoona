"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const NAV_LINKS = [
  { href: "/characters", label: "شخصیت‌ها" },
  { href: "/examples", label: "نمونه‌ها" },
  { href: "/pricing", label: "قیمت‌گذاری" },
  { href: "/safety", label: "ایمنی و حریم خصوصی" },
  { href: "/faq", label: "سوالات متداول" },
];

export function Hero() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <section
      className="relative min-h-[640px] overflow-hidden sm:min-h-[780px]"
      style={{
        background: "linear-gradient(180deg,#cdeaf6 0%,#e7dcf5 45%,#ffe2ec 100%)",
      }}
    >
      <video
        src="/videos/homepage/hero.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        className="absolute inset-0 h-full w-full object-cover"
      />

      <nav className="relative z-10 mx-auto mt-4 flex w-[min(1320px,92vw)] items-center justify-between gap-4 rounded-full bg-white/78 px-4 py-2.5 shadow-[0_6px_22px_rgba(80,120,150,0.16)] backdrop-blur-md sm:mt-6 sm:px-6 sm:py-3">
        <Link href="/" className="shrink-0 text-xl font-extrabold text-candy-pink sm:text-2xl">
          کارتونا
        </Link>

        <div className="hidden items-center gap-6 whitespace-nowrap text-sm font-semibold text-parent-navy md:flex">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-candy-pink transition-colors">
              {link.label}
            </Link>
          ))}
        </div>

        <div className="hidden shrink-0 items-center gap-4 md:flex">
          <Link href="/login" className="text-sm font-semibold text-parent-navy hover:text-candy-pink transition-colors">
            ورود
          </Link>
          <Link href="/signup">
            <Button size="sm" className="shadow-[0_6px_16px_rgba(242,100,154,0.35)]">
              شروع کنید
            </Button>
          </Link>
        </div>

        <div className="flex shrink-0 items-center gap-2.5 md:hidden">
          <Link href="/signup">
            <Button size="sm" className="shadow-[0_6px_16px_rgba(242,100,154,0.35)]">
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
        <div className="relative z-10 mx-auto mt-3 flex w-[min(560px,92vw)] flex-col gap-1 rounded-[22px] bg-white/96 p-3.5 shadow-[0_14px_34px_rgba(80,120,150,0.2)] backdrop-blur-md md:hidden">
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

      <div className="relative z-10 mx-auto mt-8 mb-16 flex w-[min(900px,90vw)] flex-col items-center gap-3 rounded-[32px] border border-white/60 bg-white/55 px-6 py-8 text-center shadow-[0_18px_44px_rgba(90,120,150,0.18)] backdrop-blur-xl sm:mt-12 sm:mb-20 sm:px-12 sm:py-10">
        <span className="text-sm font-bold text-candy-pink sm:text-base">
          استودیوی خصوصی ساخت کارتون برای خانواده‌ها
        </span>
        <h1 className="font-brand text-3xl font-extrabold leading-snug tracking-tight text-parent-navy text-balance sm:text-5xl">
          خاطره‌های کارتونی جادویی بسازید
        </h1>
        <p className="max-w-xl text-base font-medium leading-loose text-[#3f4859] text-pretty sm:text-lg">
          با کارتونا، والدین می‌توانند برای کودک خود تصویر، ویدئو یا انیمیشن
          کارتونی اختصاصی سفارش دهند؛ امن، خصوصی و کاملاً تحت کنترل والدین.
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
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

        <p className="mt-2 text-sm font-semibold text-[#4a5266]">
          تحت کنترل والدین · خصوصی برای خانواده · بدون اشتراک‌گذاری عمومی
        </p>
      </div>
    </section>
  );
}

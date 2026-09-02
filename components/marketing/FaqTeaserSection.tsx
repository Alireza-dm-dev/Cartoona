"use client";

import { useState } from "react";
import Link from "next/link";
import { faqs } from "@/config/faqs";
import { GlassPanel } from "@/components/marketing/GlassPanel";

const TEASER_QUESTIONS = [
  "آیا کودک من حساب جداگانه دارد؟",
  "آیا عکس یا نقاشی کودک من عمومی می‌شود؟",
  "چگونه یک کارتون سفارش بدهم؟",
  "چه زمانی خروجی آماده می‌شود؟",
];

export function FaqTeaserSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const teaserFaqs = faqs.filter((faq) => TEASER_QUESTIONS.includes(faq.q));

  return (
    <div className="mx-auto max-w-[860px] px-6">
      <GlassPanel className="mx-auto flex max-w-[700px] flex-col items-center gap-2.5 px-6 py-7 text-center sm:px-10">
        <span className="rounded-full bg-candy-pink/10 px-4 py-1.5 text-xs font-bold text-candy-pink">
          سوالات متداول
        </span>
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[30px]">
          هر چیزی که والدین معمولاً می‌پرسند
        </h2>
      </GlassPanel>

      <div className="mt-9 flex flex-col gap-3">
        {teaserFaqs.map((faq, index) => {
          const open = openIndex === index;
          return (
            <div
              key={faq.q}
              className="overflow-hidden rounded-[18px] border border-white/70 bg-white/58 shadow-[0_10px_26px_rgba(90,120,150,0.14)] backdrop-blur-lg"
            >
              <button
                type="button"
                onClick={() => setOpenIndex(open ? null : index)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-right text-sm font-bold text-parent-navy sm:text-base"
              >
                <span>{faq.q}</span>
                <span
                  className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-candy-pink/10 text-base font-extrabold text-candy-pink transition-transform ${
                    open ? "rotate-45" : ""
                  }`}
                  aria-hidden="true"
                >
                  +
                </span>
              </button>
              {open && (
                <p className="px-5 pb-5 text-sm leading-loose text-text-dark/60 text-pretty">
                  {faq.a}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-7 flex justify-center">
        <Link href="/faq" className="text-sm font-bold text-parent-navy transition-colors hover:text-candy-pink">
          مشاهده همه‌ی سوالات متداول
        </Link>
      </div>
    </div>
  );
}

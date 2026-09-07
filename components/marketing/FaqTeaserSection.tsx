"use client";

import { useState } from "react";
import Link from "next/link";
import { faqs } from "@/config/faqs";
import type { HomepageContent } from "@/lib/homepage/types";
import { GlassPanel } from "@/components/marketing/GlassPanel";

export interface FaqTeaserSectionProps {
  content: HomepageContent["faqTeaser"];
}

/**
 * Resolves the CMS question selection against the canonical FAQ list.
 *
 * The homepage CMS stores only *which* questions to surface; the answer bodies
 * stay in `config/faqs.ts`, shared with /faq, so the teaser and the full page
 * can never drift apart. A selected question that no longer exists in the
 * canonical list is dropped rather than rendered without an answer. Selection
 * order is the editor's, not the config's.
 */
export function resolveTeaserFaqs(questions: readonly string[]) {
  return questions
    .map((question) => faqs.find((faq) => faq.q === question))
    .filter((faq): faq is (typeof faqs)[number] => faq !== undefined);
}

export function FaqTeaserSection({ content }: FaqTeaserSectionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const teaserFaqs = resolveTeaserFaqs(content.questions);

  return (
    <div className="mx-auto max-w-[860px] px-6">
      <GlassPanel className="mx-auto flex max-w-[700px] flex-col items-center gap-2.5 px-6 py-7 text-center sm:px-10">
        <span className="rounded-full bg-candy-pink/10 px-4 py-1.5 text-xs font-bold text-candy-pink">
          {content.eyebrow}
        </span>
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[30px]">
          {content.title}
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
        <Link href={content.linkHref} className="text-sm font-bold text-parent-navy transition-colors hover:text-candy-pink">
          {content.linkLabel}
        </Link>
      </div>
    </div>
  );
}

import Link from "next/link";
import { CharacterCard } from "@/components/marketing/CharacterCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";
import type { HomepageContent } from "@/lib/homepage/types";

/**
 * Card tints are raw CSS gradients and stay code-controlled - the content
 * contract deliberately models no colour. Applied by position so a reordered or
 * relabelled card set keeps the same palette rhythm.
 */
const CARD_TINTS = [
  "linear-gradient(140deg,#ffe0ee,#ffd7c2)",
  "linear-gradient(140deg,#dceeff,#e4dcff)",
  "linear-gradient(140deg,#e6f7dd,#d9f0ee)",
  "linear-gradient(140deg,#fff0cf,#ffdfe9)",
];

export interface CharactersSectionProps {
  content: HomepageContent["characters"];
}

export function CharactersSection({ content }: CharactersSectionProps) {
  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto flex max-w-[760px] flex-col items-center gap-3 px-6 py-7 text-center sm:px-10">
        <span className="rounded-full bg-candy-pink/10 px-4 py-1.5 text-xs font-bold text-candy-pink">
          {content.eyebrow}
        </span>
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[34px]">
          {content.title}
        </h2>
        <p className="max-w-lg text-sm leading-loose text-text-dark/60">
          {content.description}
        </p>
      </GlassPanel>

      <div className="mt-10 grid grid-cols-2 gap-5 lg:grid-cols-4">
        {content.cards.map((character, index) => (
          <CharacterCard
            key={character.id}
            {...character}
            tint={CARD_TINTS[index % CARD_TINTS.length]}
          />
        ))}
      </div>

      <div className="mt-8 flex justify-center">
        <Link
          href={content.cta.href}
          className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/50 px-7 py-3.5 text-sm font-bold text-parent-navy shadow-[0_8px_20px_rgba(90,120,150,0.16)] backdrop-blur-lg transition-colors hover:text-candy-pink"
        >
          {content.cta.label}
        </Link>
      </div>
    </div>
  );
}

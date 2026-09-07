import { CreationTypeCard } from "@/components/marketing/CreationTypeCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";
import type { HomepageContent, BuildOptionMediaKey } from "@/lib/homepage/types";
import { HOMEPAGE_MEDIA_SLOTS, type HomepageMediaSlot } from "@/lib/homepage/media-slots";
import type { ResolvedHomepageMedia } from "@/lib/homepage/resolve-core";

/**
 * The closed mapping from a card's bounded media key to the canonical slot it
 * renders. A card can only name one of these three keys (the content contract
 * enforces it), so an editor can never point a card at an arbitrary slot or URL.
 */
const CARD_MEDIA_SLOT: Record<
  BuildOptionMediaKey,
  { slot: HomepageMediaSlot; type: "image" | "video" }
> = {
  card_image: { slot: HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_IMAGE, type: "image" },
  card_video: { slot: HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_VIDEO, type: "video" },
  card_animation: { slot: HOMEPAGE_MEDIA_SLOTS.BUILD_OPTIONS_CARD_ANIMATION, type: "video" },
};

export interface BuildOptionsSectionProps {
  content: HomepageContent["buildOptions"];
  media: ResolvedHomepageMedia;
}

export function BuildOptionsSection({ content, media }: BuildOptionsSectionProps) {
  const cards = content.cards
    // An unrecognised media key is dropped rather than rendered with no source.
    .filter((card) => card.media in CARD_MEDIA_SLOT)
    .map((card) => {
      const { slot, type } = CARD_MEDIA_SLOT[card.media];
      return {
        id: card.id,
        badge: card.badge,
        badgeVariant: card.badgeVariant,
        title: card.title,
        description: card.description,
        cta: card.cta.label,
        href: card.cta.href,
        media: { type, src: media[slot] } as
          | { type: "image"; src: string }
          | { type: "video"; src: string },
      };
    });

  return (
    <div id="creation-types" className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto flex max-w-[760px] flex-col items-center gap-2 px-6 py-6 text-center sm:px-10">
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[34px]">
          {content.title}
        </h2>
        <p className="max-w-xl text-sm leading-relaxed text-text-dark/60 sm:text-[15px]">
          {content.description}
        </p>
      </GlassPanel>

      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {cards.map((card) => (
          <CreationTypeCard key={card.id} {...card} />
        ))}
      </div>

      {/* Sits directly on the shared artwork rather than a white section, so it
          needs more weight than the /40 it carried over a flat background. */}
      <p className="mt-8 text-center text-xs text-text-dark/70">
        {content.footnote}
      </p>
    </div>
  );
}

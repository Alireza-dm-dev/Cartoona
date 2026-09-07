import { SectionShell } from "@/components/ui/section-shell";
import { Hero } from "@/components/marketing/Hero";
import { HomepageArtworkStory } from "@/components/marketing/HomepageArtworkStory";
import { BuildOptionsSection } from "@/components/marketing/BuildOptionsSection";
import { CharactersSection } from "@/components/marketing/CharactersSection";
import { SafetySection } from "@/components/marketing/SafetySection";
import { PricingSection } from "@/components/marketing/PricingSection";
import { TestimonialsSection } from "@/components/marketing/TestimonialsSection";
import { FaqTeaserSection } from "@/components/marketing/FaqTeaserSection";
import { FinalCtaSection } from "@/components/marketing/FinalCtaSection";
import { HOMEPAGE_MEDIA_SLOTS } from "@/lib/homepage/media-slots";
import { getResolvedHomepage } from "@/lib/homepage/resolver";

/**
 * The homepage reads the CMS on every request so an admin edit is visible on
 * the next page load. There is no cache layer in front of it: the read is three
 * bounded queries against a singleton row and two small tables, and the whole
 * point of the CMS is that changes take effect without a deploy.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const resolved = await getResolvedHomepage();
  const { content, media } = resolved;

  return (
    <>
      <Hero
        content={content.hero}
        navigation={content.navigation}
        media={{
          background: media[HOMEPAGE_MEDIA_SLOTS.HERO_BACKGROUND],
          tv_video: media[HOMEPAGE_MEDIA_SLOTS.HERO_TV_VIDEO],
        }}
        layout={{ rect: resolved.heroLayout }}
      />

      {/* Every section after the hero shares one continuous artwork canvas, so
          none of them carries its own background: build options scrolls
          vertically, characters -> safety -> pricing pan horizontally, then
          testimonials -> faq -> final CTA return to vertical on the same
          canvas, which holds through to the end of the page. */}
      <HomepageArtworkStory
        backgroundSrc={media[HOMEPAGE_MEDIA_SLOTS.SECTIONS_BACKGROUND]}
        intro={
          <SectionShell>
            <BuildOptionsSection content={content.buildOptions} media={media} />
          </SectionShell>
        }
        panels={[
          <CharactersSection key="characters" content={content.characters} />,
          <SafetySection
            key="safety"
            content={content.safety}
            imageSrc={media[HOMEPAGE_MEDIA_SLOTS.SAFETY_IMAGE]}
          />,
          <PricingSection key="pricing" content={content.pricing} />,
        ]}
        outro={
          <>
            <SectionShell>
              <TestimonialsSection content={content.testimonials} />
            </SectionShell>
            <SectionShell>
              <FaqTeaserSection content={content.faqTeaser} />
            </SectionShell>
            <SectionShell>
              <FinalCtaSection content={content.finalCta} />
            </SectionShell>
          </>
        }
      />
    </>
  );
}

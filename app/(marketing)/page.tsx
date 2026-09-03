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

export default function HomePage() {
  return (
    <>
      <Hero />

      {/* Every section after the hero shares one continuous artwork canvas, so
          none of them carries its own background: build options scrolls
          vertically, characters -> safety -> pricing pan horizontally, then
          testimonials -> faq -> final CTA return to vertical on the same
          canvas, which holds through to the end of the page. */}
      <HomepageArtworkStory
        intro={
          <SectionShell>
            <BuildOptionsSection />
          </SectionShell>
        }
        panels={[
          <CharactersSection key="characters" />,
          <SafetySection key="safety" />,
          <PricingSection key="pricing" />,
        ]}
        outro={
          <>
            <SectionShell>
              <TestimonialsSection />
            </SectionShell>
            <SectionShell>
              <FaqTeaserSection />
            </SectionShell>
            <SectionShell>
              <FinalCtaSection />
            </SectionShell>
          </>
        }
      />
    </>
  );
}

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

      {/* Build options scrolls vertically over the shared artwork, then the
          sequence pans horizontally across characters -> safety -> pricing.
          No section in this group carries its own background: the artwork
          behind them is one continuous canvas. */}
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
      />

      <SectionShell className="bg-white">
        <TestimonialsSection />
      </SectionShell>

      <SectionShell>
        <FaqTeaserSection />
      </SectionShell>

      <SectionShell className="bg-white">
        <FinalCtaSection />
      </SectionShell>
    </>
  );
}

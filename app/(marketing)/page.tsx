import { SectionShell } from "@/components/ui/section-shell";
import { Hero } from "@/components/marketing/Hero";
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

      <SectionShell className="bg-white">
        <BuildOptionsSection />
      </SectionShell>

      <SectionShell>
        <CharactersSection />
      </SectionShell>

      <SectionShell className="bg-white">
        <SafetySection />
      </SectionShell>

      <SectionShell>
        <PricingSection />
      </SectionShell>

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

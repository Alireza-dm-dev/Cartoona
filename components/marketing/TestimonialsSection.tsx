import { TestimonialCard } from "@/components/marketing/TestimonialCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";
import type { HomepageContent } from "@/lib/homepage/types";

/** Avatar tints are raw CSS and stay code-controlled, applied by position. */
const QUOTE_TINTS = [
  "linear-gradient(140deg,#ffd9e8,#ffe6c9)",
  "linear-gradient(140deg,#dceeff,#e4dcff)",
  "linear-gradient(140deg,#dff2e4,#d6f0ec)",
];

export interface TestimonialsSectionProps {
  content: HomepageContent["testimonials"];
}

export function TestimonialsSection({ content }: TestimonialsSectionProps) {
  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto max-w-[520px] px-6 py-7 text-center">
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[30px]">
          {content.title}
        </h2>
      </GlassPanel>
      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {content.items.map((quote, index) => (
          <TestimonialCard
            key={quote.id}
            {...quote}
            tint={QUOTE_TINTS[index % QUOTE_TINTS.length]}
          />
        ))}
      </div>
    </div>
  );
}

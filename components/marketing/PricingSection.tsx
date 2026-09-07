import Link from "next/link";
import { plans } from "@/config/plans";
import { PricingPlanCard } from "@/components/marketing/PricingPlanCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";
import type { HomepageContent } from "@/lib/homepage/types";

/**
 * The teaser set the homepage has always shown. Used when the CMS selection
 * resolves to nothing - an editor emptying the list, or naming only plans that
 * no longer exist, must never blank out the pricing grid.
 */
export const DEFAULT_TEASER_PLAN_IDS = ["starter", "plus", "premium"] as const;

/**
 * Resolves a CMS plan selection against the authoritative billing config.
 *
 * The CMS supplies ids and nothing else: prices, candy amounts and benefits are
 * read from `config/plans.ts` for whichever plans are selected. Unknown ids are
 * ignored rather than fabricated.
 */
export function resolveFeaturedPlans(featuredPlanIds: readonly string[]) {
  const selected = plans.filter((plan) => featuredPlanIds.includes(plan.id));
  if (selected.length > 0) return selected;
  return plans.filter((plan) =>
    (DEFAULT_TEASER_PLAN_IDS as readonly string[]).includes(plan.id),
  );
}

export interface PricingSectionProps {
  content: HomepageContent["pricing"];
}

export function PricingSection({ content }: PricingSectionProps) {
  const teaserPlans = resolveFeaturedPlans(content.featuredPlanIds);

  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto flex max-w-[820px] flex-col items-center gap-3 px-6 py-7 text-center sm:px-10">
        <span className="rounded-full bg-candy-pink/10 px-4 py-1.5 text-xs font-bold text-candy-pink">
          {content.eyebrow}
        </span>
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[34px]">
          {content.title}
        </h2>
      </GlassPanel>

      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {teaserPlans.map((plan) => (
          <PricingPlanCard key={plan.id} plan={plan} />
        ))}
      </div>

      <div className="mt-8 flex flex-col items-center gap-2">
        <Link
          href={content.linkHref}
          className="text-sm font-bold text-parent-navy transition-colors hover:text-candy-pink"
        >
          {content.linkLabel}
        </Link>
        <p className="max-w-lg text-center text-xs text-text-dark/50">
          {content.footnote}
        </p>
      </div>
    </div>
  );
}

import { GlassPanel } from "@/components/marketing/GlassPanel";
import type { HomepageContent } from "@/lib/homepage/types";

export interface SafetySectionProps {
  content: HomepageContent["safety"];
  /** Resolved `safety.image` slot. The local fallback is resolver-owned. */
  imageSrc: string;
}

export function SafetySection({ content, imageSrc }: SafetySectionProps) {
  return (
    <div className="mx-auto grid max-w-[1200px] gap-8 px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
      <GlassPanel className="flex flex-col gap-4 px-7 py-8 sm:px-9">
        <span className="self-start rounded-full bg-mint-green/20 px-4 py-1.5 text-xs font-bold text-mint-green">
          {content.eyebrow}
        </span>
        <h2 className="font-brand text-2xl font-bold leading-snug text-parent-navy sm:text-[34px]">
          {content.title}
        </h2>
        <p className="max-w-lg text-sm leading-loose text-text-dark/60 sm:text-base">
          {content.description}
        </p>
        <div className="mt-1 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {content.points.map((point) => (
            <div key={point.id} className="flex flex-col gap-2 rounded-2xl border border-soft-border bg-white p-4">
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-mint-green/20 text-sm font-extrabold text-mint-green">
                {point.mark}
              </span>
              <strong className="text-sm font-bold text-parent-navy">{point.title}</strong>
              <p className="text-xs leading-relaxed text-text-dark/60">{point.description}</p>
            </div>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="flex flex-col gap-4 p-6">
        <div className="aspect-[4/3] overflow-hidden rounded-[20px]">
          <img
            src={imageSrc}
            alt={content.imageAlt}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-white/70 bg-white/55 px-4 py-3.5 backdrop-blur-md">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-mint-green" />
          <p className="text-xs font-semibold text-text-dark/70">
            {content.note}
          </p>
        </div>
      </GlassPanel>
    </div>
  );
}

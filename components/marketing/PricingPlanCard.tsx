import Link from "next/link";
import { formatCandies, formatPriceToman } from "@/lib/pricing/format-price";
import type { CartoonaPlan } from "@/config/plans";

interface PricingPlanCardProps {
  plan: CartoonaPlan;
}

export function PricingPlanCard({ plan }: PricingPlanCardProps) {
  const highlighted = Boolean(plan.recommended);

  return (
    <div
      className={`flex flex-col gap-4 rounded-[26px] border p-7 backdrop-blur-xl transition-transform ${
        highlighted
          ? "-translate-y-2.5 border-white/40 bg-gradient-to-br from-candy-pink/85 to-candy-pink/60 text-white shadow-[0_22px_44px_rgba(242,100,154,0.32)]"
          : "border-white/70 bg-white/58 text-parent-navy shadow-[0_10px_26px_rgba(90,120,150,0.1)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="text-lg font-extrabold tracking-tight">{plan.name}</strong>
        {highlighted && (
          <span className="rounded-full bg-white/25 px-3 py-1 text-xs font-bold text-white">
            پیشنهاد محبوب
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-extrabold">{formatPriceToman(plan.priceToman)}</span>
      </div>
      <p className={`text-xs ${highlighted ? "text-white/85" : "text-text-dark/60"}`}>
        {formatCandies(plan.candies)}
      </p>

      <p className={`text-sm leading-relaxed ${highlighted ? "text-white/90" : "text-text-dark/60"}`}>
        {plan.description}
      </p>

      <div className="mt-1 flex flex-col gap-2.5">
        {plan.benefits.map((benefit) => (
          <div key={benefit} className="flex items-center gap-2.5 text-sm font-medium">
            <span
              className={`h-[18px] w-[18px] shrink-0 rounded-full ${
                highlighted ? "bg-white/35" : "bg-candy-pink/15"
              }`}
            />
            <span>{benefit}</span>
          </div>
        ))}
      </div>

      <Link
        href="/#creation-types"
        className={`mt-auto flex items-center justify-center rounded-full px-5 py-3 text-sm font-bold transition-opacity hover:opacity-90 ${
          highlighted ? "bg-white text-candy-pink" : "bg-candy-pink/10 text-candy-pink"
        }`}
      >
        {plan.id === "exclusive" ? "شروع درخواست اختصاصی" : "شروع ساخت"}
      </Link>
    </div>
  );
}

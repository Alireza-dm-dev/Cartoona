import Link from "next/link";
import { plans } from "@/config/plans";
import { PricingPlanCard } from "@/components/marketing/PricingPlanCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";

const TEASER_PLAN_IDS = ["starter", "plus", "premium"];

export function PricingSection() {
  const teaserPlans = plans.filter((plan) => TEASER_PLAN_IDS.includes(plan.id));

  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto flex max-w-[820px] flex-col items-center gap-3 px-6 py-7 text-center sm:px-10">
        <span className="rounded-full bg-candy-pink/10 px-4 py-1.5 text-xs font-bold text-candy-pink">
          قیمت‌گذاری
        </span>
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[34px]">
          پلنی متناسب با تعداد کارتون‌هایی که می‌سازید انتخاب کنید
        </h2>
      </GlassPanel>

      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {teaserPlans.map((plan) => (
          <PricingPlanCard key={plan.id} plan={plan} />
        ))}
      </div>

      <div className="mt-8 flex flex-col items-center gap-2">
        <Link
          href="/pricing"
          className="text-sm font-bold text-parent-navy transition-colors hover:text-candy-pink"
        >
          مشاهده همه‌ی پلن‌ها و جزئیات آب‌نبات‌ها
        </Link>
        <p className="max-w-lg text-center text-xs text-text-dark/50">
          پرداخت و کسر آب‌نبات هنوز در نسخه فعلی فعال نشده است. پیش از راه‌اندازی پرداخت، قیمت‌ها به‌صورت شفاف نمایش داده می‌شوند.
        </p>
      </div>
    </div>
  );
}

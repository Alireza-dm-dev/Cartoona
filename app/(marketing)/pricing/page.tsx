import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { plans } from "@/config/plans";

const persianDigits: Record<string, string> = {
  "0": "۰",
  "1": "۱",
  "2": "۲",
  "3": "۳",
  "4": "۴",
  "5": "۵",
  "6": "۶",
  "7": "۷",
  "8": "۸",
  "9": "۹",
};

function formatPrice(priceToman: number | null): string {
  if (priceToman === null) return "براساس درخواست";
  const formatted = priceToman
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    .split("")
    .map((c) => persianDigits[c] || c)
    .join("");
  return `${formatted} تومان`;
}

function formatCandies(candies: number | null): string {
  if (candies === null) return "براساس پروژه";
  const formatted = candies
    .toString()
    .split("")
    .map((c) => persianDigits[c] || c)
    .join("");
  return `${formatted} آب‌نبات`;
}

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="پلن‌های کارتونا"
        description="پلنی را انتخاب کنید که با تعداد و نوع کارتون‌هایی که می‌خواهید بسازید هماهنگ باشد. هر پلن شامل مقداری آب‌نبات برای ساخت تصویر، ویدیو و متحرک‌سازی نقاشی است."
      />

      <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => (
          <Card key={plan.id} className="flex flex-col">
            <div className="flex items-start justify-between gap-2 mb-3">
              <h3 className="text-lg font-semibold text-parent-navy">{plan.name}</h3>
              {plan.recommended && (
                <Badge variant="warning" size="sm">
                  پیشنهاد محبوب
                </Badge>
              )}
            </div>

            <p className="text-2xl font-bold text-candy-pink">
              {formatPrice(plan.priceToman)}
            </p>
            <p className="mt-1 text-sm text-text-dark/60">
              {formatCandies(plan.candies)}
            </p>

            <p className="mt-4 text-sm text-text-dark/70">
              {plan.description}
            </p>

            <ul className="mt-4 flex flex-col gap-2 text-sm text-text-dark/60">
              {plan.benefits.map((benefit) => (
                <li key={benefit} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-mint-green">✓</span>
                  {benefit}
                </li>
              ))}
            </ul>

            <div className="mt-auto pt-6">
              <Link href="/#creation-types">
                <Button className="w-full">
                  {plan.id === "exclusive"
                    ? "شروع درخواست اختصاصی"
                    : "شروع ساخت"}
                </Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-3">آب‌نبات چگونه استفاده می‌شود؟</h3>
        <ul className="flex flex-col gap-2 text-sm text-text-dark/70">
          <li className="flex items-start gap-2">
            <span className="mt-1 shrink-0">•</span>
            هر ساخت تصویر، ویدیو یا متحرک‌سازی نقاشی مقدار مشخصی آب‌نبات مصرف می‌کند.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 shrink-0">•</span>
            هزینه نهایی پیش از ثبت درخواست نمایش داده می‌شود.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 shrink-0">•</span>
            درخواست‌های پیچیده‌تر یا ویدیوهای طولانی‌تر آب‌نبات بیشتری نیاز دارند.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 shrink-0">•</span>
            پلن اختصاصی پس از بررسی جزئیات قیمت‌گذاری می‌شود.
          </li>
        </ul>
      </Card>

      <div className="text-center">
        <p className="text-xs text-text-dark/50">
          پرداخت و کسر آب‌نبات هنوز در نسخه فعلی فعال نشده است. پیش از راه‌اندازی پرداخت، قیمت‌ها و هزینه هر نوع ساخت به‌صورت شفاف نمایش داده می‌شوند.
        </p>
      </div>
    </div>
  );
}

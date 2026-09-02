import { GlassPanel } from "@/components/marketing/GlassPanel";

const SAFETY_POINTS = [
  { mark: "۱", title: "بدون انتشار عمومی", desc: "هیچ خروجی‌ای در شبکه‌های اجتماعی یا گالری عمومی قرار نمی‌گیرد." },
  { mark: "۲", title: "حذف در یک کلیک", desc: "عکس‌ها و سفارش‌ها را هر زمان به‌طور کامل پاک کنید." },
  { mark: "۳", title: "بدون حساب کودک", desc: "همه‌چیز از طریق حساب والدین مدیریت می‌شود." },
  { mark: "۴", title: "بازبینی انسانی", desc: "هر سفارش پیش از تحویل توسط تیم بررسی می‌شود." },
];

export function SafetySection() {
  return (
    <div className="mx-auto grid max-w-[1200px] gap-8 px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
      <GlassPanel className="flex flex-col gap-4 px-7 py-8 sm:px-9">
        <span className="self-start rounded-full bg-mint-green/20 px-4 py-1.5 text-xs font-bold text-mint-green">
          ایمنی و حریم خصوصی
        </span>
        <h2 className="font-brand text-2xl font-bold leading-snug text-parent-navy sm:text-[34px]">
          هیچ‌کس جز خانواده‌ی شما کودکتان را نمی‌بیند
        </h2>
        <p className="max-w-lg text-sm leading-loose text-text-dark/60 sm:text-base">
          هیچ محتوایی به‌صورت عمومی منتشر نمی‌شود. عکس‌ها فقط برای ساخت سفارش شما استفاده می‌شوند و هر زمان بخواهید حذف می‌شوند.
        </p>
        <div className="mt-1 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {SAFETY_POINTS.map((point) => (
            <div key={point.mark} className="flex flex-col gap-2 rounded-2xl border border-soft-border bg-white p-4">
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-mint-green/20 text-sm font-extrabold text-mint-green">
                {point.mark}
              </span>
              <strong className="text-sm font-bold text-parent-navy">{point.title}</strong>
              <p className="text-xs leading-relaxed text-text-dark/60">{point.desc}</p>
            </div>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="flex flex-col gap-4 p-6">
        <div className="aspect-[4/3] overflow-hidden rounded-[20px]">
          <img
            src="/images/homepage/family-tablet.jpg"
            alt="خانواده در حال تماشای سفارش کودک روی تبلت"
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-white/70 bg-white/55 px-4 py-3.5 backdrop-blur-md">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-mint-green" />
          <p className="text-xs font-semibold text-text-dark/70">
            همه‌ی سفارش‌ها پیش از تحویل توسط تیم انسانی بررسی می‌شوند.
          </p>
        </div>
      </GlassPanel>
    </div>
  );
}

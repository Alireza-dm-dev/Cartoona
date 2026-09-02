import { CreationTypeCard } from "@/components/marketing/CreationTypeCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";

const OPTIONS = [
  {
    badge: "تصویر",
    badgeVariant: "default" as const,
    title: "تصویر کارتونی اختصاصی",
    description: "یک تصویر کارتونی شخصی‌سازی‌شده با شخصیت، صحنه و سبک دلخواه بسازید.",
    cta: "شروع ساخت تصویر",
    href: "/create-image",
    media: { type: "image" as const, src: "/images/homepage/card-image.jpg" },
  },
  {
    badge: "ویدیو",
    badgeVariant: "info" as const,
    title: "ویدیوی کارتونی",
    description: "یک داستان یا پیام کوتاه را به ویدیوی کارتونی شخصی‌سازی‌شده تبدیل کنید.",
    cta: "شروع ساخت ویدیو",
    href: "/request-video",
    media: { type: "video" as const, src: "/videos/homepage/build-video.mp4" },
  },
  {
    badge: "نقاشی متحرک",
    badgeVariant: "success" as const,
    title: "متحرک‌سازی نقاشی",
    description: "نقاشی کودک را به یک انیمیشن کوتاه و زنده تبدیل کنید.",
    cta: "شروع متحرک‌سازی",
    href: "/animate-drawing",
    media: { type: "video" as const, src: "/videos/homepage/build-animate.mp4" },
  },
];

export function BuildOptionsSection() {
  return (
    <div id="creation-types" className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto flex max-w-[760px] flex-col items-center gap-2 px-6 py-6 text-center sm:px-10">
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[34px]">
          چه چیزی می‌خواهید بسازید؟
        </h2>
        <p className="max-w-xl text-sm leading-relaxed text-text-dark/60 sm:text-[15px]">
          یکی از روش‌های ساخت را انتخاب کنید. جزئیات درخواست را ابتدا وارد می‌کنید و فقط هنگام ثبت نهایی وارد حساب می‌شوید یا حساب می‌سازید.
        </p>
      </GlassPanel>

      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {OPTIONS.map((option) => (
          <CreationTypeCard key={option.href} {...option} />
        ))}
      </div>

      <p className="mt-8 text-center text-xs text-text-dark/40">
        می‌توانید ابتدا نوع و جزئیات ساخت را انتخاب کنید؛ ورود یا ساخت حساب فقط هنگام ثبت نهایی درخواست لازم است.
      </p>
    </div>
  );
}

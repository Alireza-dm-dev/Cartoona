import { TestimonialCard } from "@/components/marketing/TestimonialCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";

const QUOTES = [
  {
    quote:
      "دخترم هر شب ویدئوی خودش را می‌بیند و می‌خندد. اینکه هیچ‌جا منتشر نمی‌شود برای ما مهم‌ترین بخش بود.",
    name: "سمیرا ر.",
    role: "مادر یک کودک ۵ ساله",
    tint: "linear-gradient(140deg,#ffd9e8,#ffe6c9)",
  },
  {
    quote:
      "نقاشی پسرم را فرستادیم و دو روز بعد یک انیمیشن کوتاه گرفتیم. باورش سخت بود که همان نقاشی خودش است.",
    name: "محمد ک.",
    role: "پدر دو کودک",
    tint: "linear-gradient(140deg,#dceeff,#e4dcff)",
  },
  {
    quote:
      "برای تولد خواهرزاده‌ام یک پیام کارتونی ساختم؛ ساده‌ترین هدیه‌ای بود که بیشترین ذوق را داشت.",
    name: "نگار م.",
    role: "خاله‌ی یک کودک ۴ ساله",
    tint: "linear-gradient(140deg,#dff2e4,#d6f0ec)",
  },
];

export function TestimonialsSection() {
  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto max-w-[520px] px-6 py-7 text-center">
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[30px]">
          والدین چه می‌گویند
        </h2>
      </GlassPanel>
      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {QUOTES.map((quote) => (
          <TestimonialCard key={quote.name} {...quote} />
        ))}
      </div>
    </div>
  );
}

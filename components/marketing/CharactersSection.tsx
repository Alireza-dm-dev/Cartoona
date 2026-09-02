import Link from "next/link";
import { CharacterCard } from "@/components/marketing/CharacterCard";
import { GlassPanel } from "@/components/marketing/GlassPanel";

const CHARACTERS = [
  {
    emoji: "🐰",
    name: "میمی",
    age: "۳ تا ۶ سال",
    description: "خرگوش کنجکاوی که عاشق قصه‌های شب است.",
    tint: "linear-gradient(140deg,#ffe0ee,#ffd7c2)",
  },
  {
    emoji: "🤖",
    name: "بابو",
    age: "۴ تا ۸ سال",
    description: "ربات مهربانی که هر نقاشی را زنده می‌کند.",
    tint: "linear-gradient(140deg,#dceeff,#e4dcff)",
  },
  {
    emoji: "🦊",
    name: "نارگل",
    age: "۵ تا ۹ سال",
    description: "دختر ماجراجویی برای قصه‌های تشویقی.",
    tint: "linear-gradient(140deg,#e6f7dd,#d9f0ee)",
  },
  {
    emoji: "✨",
    name: "شخصیت شما",
    age: "اختصاصی",
    description: "از روی عکس کودک شما ساخته می‌شود.",
    tint: "linear-gradient(140deg,#fff0cf,#ffdfe9)",
  },
];

export function CharactersSection() {
  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <GlassPanel className="mx-auto flex max-w-[760px] flex-col items-center gap-3 px-6 py-7 text-center sm:px-10">
        <span className="rounded-full bg-candy-pink/10 px-4 py-1.5 text-xs font-bold text-candy-pink">
          شخصیت‌ها
        </span>
        <h2 className="font-brand text-2xl font-bold text-parent-navy sm:text-[34px]">
          شخصیت‌های دوست‌داشتنی کارتونا
        </h2>
        <p className="max-w-lg text-sm leading-loose text-text-dark/60">
          یکی از شخصیت‌های اصلی را انتخاب کنید یا از روی عکس کودکتان یک شخصیت اختصاصی بسازید. همه‌ی شخصیت‌ها برای سنین کودکی طراحی شده‌اند.
        </p>
      </GlassPanel>

      <div className="mt-10 grid grid-cols-2 gap-5 lg:grid-cols-4">
        {CHARACTERS.map((character) => (
          <CharacterCard key={character.name} {...character} />
        ))}
      </div>

      <div className="mt-8 flex justify-center">
        <Link
          href="/characters"
          className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/50 px-7 py-3.5 text-sm font-bold text-parent-navy shadow-[0_8px_20px_rgba(90,120,150,0.16)] backdrop-blur-lg transition-colors hover:text-candy-pink"
        >
          مشاهده همه‌ی شخصیت‌ها
        </Link>
      </div>
    </div>
  );
}

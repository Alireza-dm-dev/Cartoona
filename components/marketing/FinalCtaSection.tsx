import Link from "next/link";
import { Button } from "@/components/ui/button";

export function FinalCtaSection() {
  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <div
        className="flex flex-col items-center gap-4 rounded-[34px] border border-white/65 px-8 py-16 text-center shadow-[0_24px_60px_rgba(242,100,154,0.18)] backdrop-blur-xl sm:px-12"
        style={{
          background:
            "linear-gradient(135deg, rgba(255,217,232,0.62), rgba(255,233,211,0.5) 55%, rgba(217,238,251,0.6))",
        }}
      >
        <h2 className="font-brand text-3xl font-extrabold tracking-tight text-parent-navy sm:text-[40px]">
          امشب اولین کارتون کودکتان را بسازید
        </h2>
        <p className="max-w-lg text-base leading-loose text-[#4b5468]">
          چند دقیقه وقت می‌گیرد؛ نتیجه‌اش خاطره‌ای است که سال‌ها می‌ماند.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3.5">
          <Link href="#creation-types">
            <Button size="lg" className="shadow-[0_10px_24px_rgba(242,100,154,0.4)]">
              شروع ساخت کارتون
            </Button>
          </Link>
          <Link href="/examples">
            <Button variant="secondary" size="lg">
              مشاهده نمونه‌ها
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

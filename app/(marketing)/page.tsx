import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionShell } from "@/components/ui/section-shell";
import {
  IllustrationVideo,
  IllustrationDrawing,
  IllustrationStory,
} from "@/components/illustrations";

export default function HomePage() {
  return (
    <>
      <SectionShell className="flex flex-col items-center text-center">
        <span className="mb-4 inline-block text-6xl" aria-hidden="true">🎨</span>
        <p className="mb-2 text-sm font-medium text-candy-pink">
          استودیوی خصوصی ساخت کارتون برای خانواده‌ها
        </p>
        <h1 className="font-brand max-w-2xl text-4xl font-bold text-parent-navy md:text-5xl">
          خاطره‌های کارتونی جادویی بسازید
        </h1>
        <p className="mt-4 max-w-xl text-lg text-text-dark/70">
          با کارتونا، والدین می‌توانند برای کودک خود تصویر، ویدئو یا انیمیشن
          کارتونی اختصاصی سفارش دهند؛ امن، خصوصی و کاملاً تحت کنترل والدین.
        </p>
        <div className="mt-8 flex gap-4">
          <Link href="#creation-types">
            <Button size="lg">شروع ساخت کارتون</Button>
          </Link>
          <Link href="/examples">
            <Button variant="secondary" size="lg">مشاهده نمونه‌ها</Button>
          </Link>
        </div>
        <p className="mt-6 text-sm text-text-dark/50">
          🛡️ تحت کنترل والدین · خصوصی برای خانواده · بدون اشتراک‌گذاری عمومی
        </p>
      </SectionShell>

      <SectionShell>
        <div id="creation-types" className="mx-auto max-w-[1200px] px-6">
          <div className="mb-12 text-center">
            <h2 className="font-brand text-2xl font-bold text-parent-navy">
              چه چیزی می‌خواهید بسازید؟
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-text-dark/70">
              یکی از روش‌های ساخت را انتخاب کنید. جزئیات درخواست را ابتدا وارد می‌کنید و فقط هنگام ثبت نهایی وارد حساب می‌شوید یا حساب می‌سازید.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-candy-pink/20 to-sky-blue/20" aria-hidden="true">
                <span className="text-2xl">🖼️</span>
              </div>
              <Badge variant="default" className="mb-3">تصویر</Badge>
              <h3 className="font-semibold text-text-dark">تصویر کارتونی اختصاصی</h3>
              <p className="mt-1 text-sm text-text-dark/60">
                یک تصویر کارتونی شخصی‌سازی‌شده با شخصیت، صحنه و سبک دلخواه بسازید.
              </p>
              <div className="mt-4">
                <Link href="/create-image">
                  <Button>شروع ساخت تصویر</Button>
                </Link>
              </div>
            </Card>
            <Card>
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-blue/20 to-soft-purple/20" aria-hidden="true">
                <span className="text-2xl">🎬</span>
              </div>
              <Badge variant="info" className="mb-3">ویدیو</Badge>
              <h3 className="font-semibold text-text-dark">ویدیوی کارتونی</h3>
              <p className="mt-1 text-sm text-text-dark/60">
                یک داستان یا پیام کوتاه را به ویدیوی کارتونی شخصی‌سازی‌شده تبدیل کنید.
              </p>
              <div className="mt-4">
                <Link href="/request-video">
                  <Button>شروع ساخت ویدیو</Button>
                </Link>
              </div>
            </Card>
            <Card>
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-mint-green/20 to-sunshine-yellow/20" aria-hidden="true">
                <span className="text-2xl">🎨</span>
              </div>
              <Badge variant="success" className="mb-3">نقاشی متحرک</Badge>
              <h3 className="font-semibold text-text-dark">متحرک‌سازی نقاشی</h3>
              <p className="mt-1 text-sm text-text-dark/60">
                نقاشی کودک را به یک انیمیشن کوتاه و زنده تبدیل کنید.
              </p>
              <div className="mt-4">
                <Link href="/animate-drawing">
                  <Button>شروع متحرک‌سازی</Button>
                </Link>
              </div>
            </Card>
          </div>
          <p className="mt-8 text-center text-xs text-text-dark/40">
            می‌توانید ابتدا نوع و جزئیات ساخت را انتخاب کنید؛ ورود یا ساخت حساب فقط هنگام ثبت نهایی درخواست لازم است.
          </p>
        </div>
      </SectionShell>

      <SectionShell>
        <div className="mx-auto max-w-[1200px] px-6">
          <div className="mb-12 text-center">
            <h2 className="font-brand text-2xl font-bold text-parent-navy">
              نمونه‌هایی از خاطره‌های کارتونی
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-text-dark/70">
              ببینید چگونه شخصیت‌ها و داستان‌های اختصاصی کارتونا به تجربه‌های
              تصویری دوست‌داشتنی تبدیل می‌شوند.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <div className="mb-4 aspect-video rounded-2xl bg-gradient-to-br from-sky-blue/20 to-soft-purple/20 flex items-center justify-center">
                <IllustrationVideo />
              </div>
              <Badge variant="info" className="mb-3">ویدئوی کارتونی</Badge>
              <h3 className="font-semibold text-text-dark">پیام‌های تصویری اختصاصی</h3>
              <p className="mt-1 text-sm text-text-dark/60">
                یک ویدئوی کوتاه و اختصاصی برای پیام‌های تولد، تشویق یا مناسبت‌های
                خاص. کاملاً خصوصی و امن.
              </p>
              <Link
                href="/examples"
                className="mt-4 inline-flex items-center text-sm font-medium text-candy-pink hover:opacity-80 transition-opacity"
              >
                مشاهده نمونه
              </Link>
            </Card>
            <Card>
              <div className="mb-4 aspect-video rounded-2xl bg-gradient-to-br from-mint-green/20 to-sunshine-yellow/20 flex items-center justify-center">
                <IllustrationDrawing />
              </div>
              <Badge variant="success" className="mb-3">جان‌بخشی به نقاشی</Badge>
              <h3 className="font-semibold text-text-dark">انیمیشن از نقاشی کودک</h3>
              <p className="mt-1 text-sm text-text-dark/60">
                نقاشی کودک شما با دقت به یک انیمیشن کوتاه و دوست‌داشتنی تبدیل
                می‌شود.
              </p>
              <Link
                href="/examples"
                className="mt-4 inline-flex items-center text-sm font-medium text-candy-pink hover:opacity-80 transition-opacity"
              >
                مشاهده نمونه
              </Link>
            </Card>
            <Card>
              <div className="mb-4 aspect-video rounded-2xl bg-gradient-to-br from-candy-pink/20 to-sky-blue/20 flex items-center justify-center">
                <IllustrationStory />
              </div>
              <Badge variant="default" className="mb-3">داستان شخصیتی</Badge>
              <h3 className="font-semibold text-text-dark">داستان تصویری اختصاصی</h3>
              <p className="mt-1 text-sm text-text-dark/60">
                شخصیت‌های کارتونا در یک داستان تصویری اختصاصی برای کودک شما
                نقش‌آفرینی می‌کنند.
              </p>
              <Link
                href="/examples"
                className="mt-4 inline-flex items-center text-sm font-medium text-candy-pink hover:opacity-80 transition-opacity"
              >
                مشاهده نمونه
              </Link>
            </Card>
          </div>
        </div>
      </SectionShell>

      <SectionShell className="bg-white">
        <div className="mx-auto max-w-[1200px] px-6">
          <h2 className="font-brand mb-12 text-center text-2xl font-bold text-parent-navy">
            روش کار
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <div className="mb-3 text-3xl" aria-hidden="true">۱</div>
              <h3 className="font-semibold text-text-dark">انتخاب و درخواست</h3>
              <p className="mt-2 text-sm text-text-dark/60">
                شخصیت‌های اصلی کارتونا را انتخاب کنید و توضیح دهید چه می‌خواهید.
              </p>
            </Card>
            <Card>
              <div className="mb-3 text-3xl" aria-hidden="true">۲</div>
              <h3 className="font-semibold text-text-dark">ما می‌سازیم</h3>
              <p className="mt-2 text-sm text-text-dark/60">
                تیم ما هر درخواست را با دقت و رعایت امنیت بررسی و آماده می‌کند.
              </p>
            </Card>
            <Card>
              <div className="mb-3 text-3xl" aria-hidden="true">۳</div>
              <h3 className="font-semibold text-text-dark">دریافت و لذت بردن</h3>
              <p className="mt-2 text-sm text-text-dark/60">
                تحویل کاملاً خصوصی — فقط خانواده شما کارتون نهایی را می‌بیند.
              </p>
            </Card>
          </div>
        </div>
      </SectionShell>

      <SectionShell className="text-center">
        <h2 className="font-brand text-2xl font-bold text-parent-navy">
          ساخته‌شده توسط والدین، برای والدین
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-text-dark/70">
          همه چیز تحت کنترل شماست. بارگذاری، درخواست، دریافت و حذف اطلاعات
          فقط توسط شما مدیریت می‌شود. بدون حساب کودک. بدون اشتراک‌گذاری عمومی.
        </p>
      </SectionShell>
    </>
  );
}

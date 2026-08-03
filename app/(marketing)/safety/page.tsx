import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SafetyNotice } from "@/components/ui/safety-notice";

const principles = [
  {
    title: "حساب فقط برای والدین",
    description:
      "در نسخه MVP، کودکان حساب مستقل ندارند و همه اقدامات مهم توسط والدین انجام می‌شود.",
  },
  {
    title: "خصوصی به‌صورت پیش‌فرض",
    description:
      "درخواست‌ها، فایل‌های بارگذاری‌شده و خروجی‌های نهایی در داشبورد خصوصی خانواده نمایش داده می‌شوند.",
  },
  {
    title: "تأیید والدین قبل از بارگذاری",
    description:
      "برای بارگذاری عکس یا نقاشی کودک، تأیید والد یا سرپرست لازم است.",
  },
  {
    title: "بدون شبکه اجتماعی",
    description:
      "کارتونا در MVP هیچ لایک، کامنت، دنبال‌کردن یا گالری عمومی ندارد.",
  },
  {
    title: "بازبینی قبل از تحویل",
    description:
      "درخواست‌ها و خروجی‌ها قبل از تحویل توسط تیم بررسی می‌شوند تا تجربه‌ای امن‌تر ایجاد شود.",
  },
  {
    title: "کنترل حذف داده‌ها",
    description:
      "والدین می‌توانند در نسخه‌های بعدی فایل‌ها، پروفایل کودک و خروجی‌های نهایی را مدیریت و حذف کنند.",
  },
];

export default function SafetyPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="امنیت و حریم خصوصی"
        description="کارتونا برای والدین طراحی شده است؛ جایی که ساخت، بارگذاری، پرداخت، دانلود و حذف محتوا فقط تحت کنترل والدین انجام می‌شود."
      />
      <div className="mb-8 text-center">
        <span className="inline-block rounded-full bg-mint-green/10 px-3 py-0.5 text-xs text-mint-green">
          والد-محور و خصوصی
        </span>
        <h2 className="mt-4 text-2xl font-bold text-parent-navy">
          اعتماد والدین، اصل اول کارتونا
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-text-dark/70">
          در کارتونا، کودک حساب مستقل ندارد. والدین مسئول ثبت درخواست، تأیید
          بارگذاری فایل، مشاهده خروجی و مدیریت داده‌ها هستند.
        </p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {principles.map((principle) => (
          <Card key={principle.title} variant="admin">
            <h3 className="font-semibold text-parent-navy">{principle.title}</h3>
            <p className="mt-2 text-sm text-text-dark/60">{principle.description}</p>
          </Card>
        ))}
      </div>
      <div className="mt-8">
        <SafetyNotice title="تعهد ما">
          حریم خصوصی خانواده شما اولویت اصلی کارتونا است. اگر نتوانیم امنیت را
          تضمین کنیم، آن ویژگی را عرضه نمی‌کنیم.
        </SafetyNotice>
      </div>
      <Card variant="admin" className="mt-6 border-sunshine-yellow/30 bg-sunshine-yellow/5">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden="true">📝</span>
          <div>
            <h3 className="font-semibold text-parent-navy">یادداشت مهم</h3>
            <p className="mt-1 text-sm text-text-dark/70">
              این صفحه راهنمای طراحی محصول است و جایگزین سیاست حقوقی یا حریم
              خصوصی نهایی نیست. متن‌های قانونی باید قبل از انتشار عمومی توسط
              تیم حقوقی بررسی شوند.
            </p>
          </div>
        </div>
      </Card>
      <div className="mt-16 text-center">
        <h2 className="text-2xl font-bold text-parent-navy">
          با خیال راحت شروع کنید
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-text-dark/70">
          مسیر ساخت کارتون در کارتونا ساده، خصوصی و تحت کنترل والدین طراحی شده
          است.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link href="/create-image">
            <Button size="lg">ساخت کارتون جدید</Button>
          </Link>
          <Link href="/examples">
            <Button variant="secondary" size="lg">مشاهده نمونه‌ها</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

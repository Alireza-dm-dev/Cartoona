import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { SafetyNotice } from "@/components/ui/safety-notice";

export default function GalleryPage() {
  return (
    <div>
      <PageHeader
        title="گالری خصوصی من"
        description="کارتون‌ها، تصاویر و ویدیوهای آماده‌شده شما در این بخش نمایش داده می‌شوند."
      />
      <EmptyState
        title="هنوز اثری در گالری شما نیست"
        description="پس از آماده‌شدن و تحویل درخواست‌ها، فایل‌های نهایی به‌صورت خصوصی در این بخش قرار می‌گیرند."
        action={
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link href="/create-image">
              <Button size="lg">ساخت کارتون جدید</Button>
            </Link>
            <Link href="/dashboard/orders">
              <Button variant="secondary" size="lg">مشاهده درخواست‌ها</Button>
            </Link>
          </div>
        }
      />
      <div className="mt-6">
        <SafetyNotice title="گالری خصوصی شماست">
          فقط شما می‌توانید آثار و فایل‌های تحویل‌شده حساب خود را مشاهده کنید.
          پس از تکمیل و تحویل هر درخواست، فایل نهایی در این بخش نمایش داده می‌شود.
        </SafetyNotice>
      </div>
    </div>
  );
}

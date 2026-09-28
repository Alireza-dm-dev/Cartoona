import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SafetyNotice } from "@/components/ui/safety-notice";
import { NewRequestActions } from "@/components/dashboard/new-request-actions";
import { GalleryMediaCard } from "@/components/dashboard/gallery/gallery-media-card";
import { getParentGalleryMedia } from "@/lib/parent/gallery/queries";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * /dashboard/gallery — the parent's private source-media library.
 *
 * Holds the media the parent uploaded *for* a request — child photos,
 * reference images, drawings — so it can be reused on a later request without
 * being found and uploaded again. Delivered output is deliberately not here:
 * it belongs to the request it was produced for, on the order detail page.
 *
 * Read on every request because signed preview URLs are short-lived and must
 * not be cached into a stale page.
 */
export const dynamic = "force-dynamic";

export default async function GalleryPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?from=/dashboard/gallery");

  return (
    <div className="mx-auto max-w-[880px]">
      <PageHeader
        title="گالری خصوصی من"
        description="فایل‌هایی که برای ساخت درخواست‌ها بارگذاری کرده‌اید، اینجا نگهداری می‌شوند تا بتوانید دوباره از آن‌ها استفاده کنید."
      />

      <Suspense fallback={<GalleryLoadingState />}>
        <GalleryContent />
      </Suspense>

      <div className="mt-6">
        <SafetyNotice title="گالری خصوصی شماست">
          فقط شما به این فایل‌ها دسترسی دارید. پیش‌نمایش‌ها کوتاه‌مدت هستند و
          هیچ فایلی به‌صورت عمومی منتشر نمی‌شود.
        </SafetyNotice>
      </div>
    </div>
  );
}

async function GalleryContent() {
  const supabase = await createServerSupabaseClient();
  const result = await getParentGalleryMedia(supabase);

  if (!result.ok) {
    if (result.reason === "no_parent_profile") return <GalleryNoProfileState />;
    return <GalleryErrorState />;
  }

  if (result.media.length === 0) return <GalleryEmptyState />;

  return (
    <>
      <p className="mb-3 text-sm text-text-dark/60">
        برای استفاده دوباره از این فایل‌ها، هنگام ثبت درخواست جدید گزینه‌ی
        «انتخاب از گالری خصوصی» را انتخاب کنید.
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {result.media.map((media) => (
          <GalleryMediaCard key={media.id} media={media} />
        ))}
      </div>
      <div className="mt-8">
        <NewRequestActions />
      </div>
    </>
  );
}

/** No source media yet. Explains what will land here and how. */
function GalleryEmptyState() {
  return (
    <>
      <EmptyState
        icon="🖼️"
        title="هنوز فایلی در گالری شما نیست"
        description="هر تصویر، عکس کودک یا نقاشی که برای ثبت یک درخواست بارگذاری کنید، همین‌جا ذخیره می‌شود تا در درخواست‌های بعدی بتوانید دوباره از آن استفاده کنید."
      />
      <div className="mt-6">
        <NewRequestActions />
      </div>
    </>
  );
}

/**
 * Read failure. Says nothing about the underlying cause: the parent can only
 * retry, and the detail would be operational noise at best and a leak at worst.
 */
function GalleryErrorState() {
  return (
    <Card className="border-coral/30 bg-coral/5 text-center">
      <h3 className="mb-2 font-semibold text-parent-navy">گالری بارگذاری نشد</h3>
      <p className="text-sm text-text-dark/70">
        ارتباط با سرور برقرار نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.
      </p>
    </Card>
  );
}

/** Signed-in account that has not completed consent yet. */
function GalleryNoProfileState() {
  return (
    <Card className="border-soft-purple/30 bg-soft-purple/5 text-center">
      <h3 className="mb-2 font-semibold text-parent-navy">پروفایل والد کامل نیست</h3>
      <p className="text-sm text-text-dark/70">
        برای دیدن گالری خصوصی ابتدا رضایت والدین را ثبت کنید.
      </p>
    </Card>
  );
}

function GalleryLoadingState() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری گالری…</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="neu-raised overflow-hidden rounded-xl">
          <div className="aspect-square animate-pulse bg-soft-border/40" />
          <div className="px-3 py-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-soft-border/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

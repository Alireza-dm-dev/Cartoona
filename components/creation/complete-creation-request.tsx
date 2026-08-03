"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { readCreationDraft } from "@/lib/creation/creation-draft";
import type { CreationDraft, ImageCreationDraft, VideoCreationDraft, DrawingCreationDraft } from "@/lib/creation/creation-draft";
import { CreationDraftSummaryCard } from "@/components/creation/pending-creation-draft-card";
import { useCreationPricing } from "@/lib/pricing/use-creation-pricing";
import { calculateCreationCost } from "@/lib/pricing/calculate-creation-cost";
import { FORM_TO_INTERNAL } from "@/lib/pricing/pricing-keys";
import type { InternalDuration } from "@/lib/pricing/pricing-keys";

const imageAcceptedTypes = "image/png,image/jpeg,image/webp";
const videoReferenceAcceptedTypes = "image/png,image/jpeg,image/webp,video/mp4,video/webm";

const imageAcceptedMimeTypes = ["image/png", "image/jpeg", "image/webp"];
const videoReferenceAcceptedMimeTypes = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"];

export default function CompleteCreationRequest() {
  const [draft, setDraft] = useState<CreationDraft | null>(null);
  const [hasFinishedLoading, setHasFinishedLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { catalog, loading: pricingLoading, error: pricingError, refresh: refreshPricing } = useCreationPricing();

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDraft(readCreationDraft());
      setHasFinishedLoading(true);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  const costResult = (() => {
    if (!catalog || !draft) return null
    if (draft.type === "image") {
      return calculateCreationCost(catalog, "image", null, Boolean((draft as ImageCreationDraft).referenceFileName))
    }
    if (draft.type === "video") {
      const d = (draft as VideoCreationDraft).duration
      const dur: InternalDuration | null = d ? FORM_TO_INTERNAL[d] : null
      if (!dur) return null
      return calculateCreationCost(catalog, "video", dur, Boolean((draft as VideoCreationDraft).referenceFileName))
    }
    if (draft.type === "drawing") {
      const d = (draft as DrawingCreationDraft).duration
      const dur: InternalDuration | null = d ? FORM_TO_INTERNAL[d] : null
      if (!dur) return null
      return calculateCreationCost(catalog, "drawing_animation", dur, false)
    }
    return null
  })()

  if (!hasFinishedLoading) {
    return (
      <p className="text-sm text-text-dark/50" aria-live="polite">
        در حال آماده‌سازی خلاصه درخواست…
      </p>
    );
  }

  if (!draft) {
    return (
      <EmptyState
        title="درخواستی برای تکمیل پیدا نشد"
        description="برای شروع، یکی از روش‌های ساخت تصویر، ویدیو یا متحرک‌سازی نقاشی را انتخاب کنید."
        action={
          <div className="flex flex-col items-center gap-3">
            <Link href="/#creation-types">
              <Button>شروع ساخت</Button>
            </Link>
            <Link
              href="/dashboard"
              className="text-xs text-text-dark/50 hover:text-text-dark/70"
            >
              رفتن به داشبورد
            </Link>
          </div>
        }
      />
    );
  }

  const requiresFileReselection = draft.type === "drawing"
    ? true
    : (draft.type === "image" || draft.type === "video") && Boolean(
        (draft as ImageCreationDraft | VideoCreationDraft).referenceFileName,
      );

  const originalFileName = draft.type === "drawing"
    ? (draft as DrawingCreationDraft).drawingFileName
    : (draft as ImageCreationDraft | VideoCreationDraft).referenceFileName;

  const acceptedFileTypes = draft.type === "video"
    ? videoReferenceAcceptedTypes
    : imageAcceptedTypes;

  const acceptedMimeTypes = draft.type === "video"
    ? videoReferenceAcceptedMimeTypes
    : imageAcceptedMimeTypes;

  const fileSelectionLabel = draft.type === "drawing"
    ? "انتخاب دوباره نقاشی"
    : "انتخاب دوباره فایل مرجع";

  const fileSelected = selectedFile !== null;

  const fileRequiredAndMissing = requiresFileReselection && !fileSelected;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError("");
    const file = e.target.files?.[0];
    if (!file) return;

    if (!acceptedMimeTypes.includes(file.type)) {
      setFileError("فرمت این فایل پشتیبانی نمی‌شود. لطفاً یک فایل مجاز انتخاب کنید.");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    setSelectedFile(file);
  }

  function handleRemoveFile() {
    setSelectedFile(null);
    setFileError("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function getReadinessText(): string {
    if (fileRequiredAndMissing) {
      return "برای ادامه، ابتدا فایل لازم را دوباره انتخاب کنید. ثبت نهایی پس از اتصال سفارش‌ها و بارگذاری خصوصی فایل فعال می‌شود.";
    }
    if (requiresFileReselection && fileSelected) {
      return "فایل و اطلاعات درخواست آماده هستند. ثبت نهایی پس از اتصال سفارش‌ها و بارگذاری خصوصی فایل فعال می‌شود.";
    }
    return "اطلاعات درخواست آماده است. ثبت نهایی پس از اتصال سفارش‌ها فعال می‌شود.";
  }

  return (
    <div className="space-y-6">
      <CreationDraftSummaryCard
        draft={draft}
        stage="completion"
        currentCandyCost={costResult?.available === true ? costResult.candyCost : undefined}
      />

      {requiresFileReselection && (
        <Card>
          <h2 className="font-semibold text-parent-navy">انتخاب دوباره فایل</h2>
          <p className="mt-1 text-sm text-text-dark/60">
            {draft.type === "drawing"
              ? "برای ثبت نهایی، تصویر اصلی نقاشی را دوباره از دستگاه خود انتخاب کنید."
              : "برای ثبت نهایی، فایل مرجعی را که در مرحله ساخت انتخاب کرده بودید دوباره انتخاب کنید."}
          </p>

          <div className="mt-4 space-y-4">
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-text-dark/50 shrink-0">نام فایل قبلی</span>
              <span className="text-text-dark font-medium text-left">
                {originalFileName}
              </span>
            </div>

            {fileSelected ? (
              <div className="rounded-lg border border-mint-green/30 bg-mint-green/10 px-3 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className="shrink-0 font-medium text-mint-green">
                    انتخاب شده
                  </span>
                  <span className="flex-1 truncate text-text-dark">
                    {selectedFile.name}
                  </span>
                  <button
                    type="button"
                    onClick={handleRemoveFile}
                    className="shrink-0 text-xs text-coral hover:opacity-80"
                  >
                    حذف فایل
                  </button>
                </div>
                <p className="mt-1 text-xs text-mint-green">
                  آماده برای مرحله ثبت نهایی
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/50">
                  فایل فقط در حافظه همین صفحه نگه‌داری می‌شود و هنوز بارگذاری
                  نشده است.
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-candy-pink hover:opacity-80 self-start">
                  {fileSelectionLabel}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={acceptedFileTypes}
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </label>
              </div>
            )}

            {fileError && (
              <p className="text-sm text-coral" role="alert">
                {fileError}
              </p>
            )}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="font-semibold text-parent-navy">مرحله ثبت نهایی</h2>
        <p className="mt-1 text-sm text-text-dark/60">
          در مرحله بعد، فایل‌های لازم دوباره انتخاب می‌شوند و درخواست پس از
          تأیید شما ثبت خواهد شد.
        </p>

        {!requiresFileReselection && (
          <p className="mt-2 text-xs text-text-dark/40">
            برای این درخواست فایل مرجع لازم نیست.
          </p>
        )}

        {pricingLoading && (
          <p className="mt-2 text-xs text-text-dark/50">در حال دریافت هزینه…</p>
        )}

        {pricingError || (!pricingLoading && costResult?.available === false) ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-coral">هزینه این درخواست در حال حاضر در دسترس نیست.</span>
            <button
              type="button"
              onClick={refreshPricing}
              className="text-xs text-candy-pink hover:opacity-80"
            >
              تلاش دوباره
            </button>
          </div>
        ) : null}

        {costResult?.available === true && (
          <div className="mt-2 rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-text-dark/50">هزینه برآوردی</span>
              <span className="font-bold text-text-dark">{costResult.candyCost.toLocaleString("fa-IR")} آب‌نبات</span>
            </div>
            <p className="mt-1 text-xs text-text-dark/40">
              هزینه نهایی بر اساس قیمت زمان ثبت درخواست محاسبه می‌شود.
            </p>
          </div>
        )}

        <p className="mt-2 text-xs text-text-dark/40">
          در حال حاضر هیچ سفارش یا کسر آب‌نباتی انجام نشده است.
        </p>

        <div className="mt-6">
          <Button disabled className="w-full">
            ثبت نهایی درخواست
          </Button>
          <p className="mt-2 text-center text-xs text-text-dark/40">
            {getReadinessText()}
          </p>
        </div>

        <div className="mt-4 text-center">
          <Link
            href="/dashboard"
            className="text-sm text-text-dark/50 hover:text-text-dark/70"
          >
            بازگشت به داشبورد
          </Link>
        </div>
      </Card>
    </div>
  );
}

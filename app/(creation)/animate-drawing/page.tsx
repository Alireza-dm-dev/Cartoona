"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CreationTypeSwitcher } from "@/components/creation/creation-type-switcher";
import { useCreationPricing } from "@/lib/pricing/use-creation-pricing";
import { calculateCreationCost } from "@/lib/pricing/calculate-creation-cost";
import { FORM_TO_INTERNAL } from "@/lib/pricing/pricing-keys";
import { saveCreationDraft } from "@/lib/creation/creation-draft";
import type { DrawingCreationDraft } from "@/lib/creation/creation-draft";
import { SafetyNotice } from "@/components/ui/safety-notice";

const stepLabels = ["انتخاب نقاشی", "جزئیات متحرک‌سازی", "بررسی نهایی"];

const movementOptions = [
  { value: "حرکت آرام و لطیف", label: "حرکت آرام و لطیف" },
  { value: "حرکت شاد و بازیگوش", label: "حرکت شاد و بازیگوش" },
  { value: "تبدیل به صحنه کارتونی", label: "تبدیل به صحنه کارتونی" },
  { value: "حرکت کوتاه برای ویدیو", label: "حرکت کوتاه برای ویدیو" },
];

const durationOptions = [
  { value: "کوتاه", label: "کوتاه" },
  { value: "متوسط", label: "متوسط" },
  { value: "بلند", label: "بلند" },
];

export default function AnimateDrawingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [drawingFileName, setDrawingFileName] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [movementType, setMovementType] = useState("");
  const [animationDescription, setAnimationDescription] = useState("");
  const [backgroundScene, setBackgroundScene] = useState("");
  const [duration, setDuration] = useState("");
  const [parentNote, setParentNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { catalog, loading: pricingLoading, error: pricingError, refresh: refreshPricing } = useCreationPricing();

  const drawingDuration = duration ? FORM_TO_INTERNAL[duration as "کوتاه" | "متوسط" | "بلند"] : null
  const costResult = catalog && drawingDuration
    ? calculateCreationCost(catalog, "drawing_animation", drawingDuration, false)
    : null;

  function validateStep1(): boolean {
    const newErrors: Record<string, string> = {};
    if (!drawingFileName) {
      newErrors.drawing = "لطفاً تصویر نقاشی کودک را انتخاب کنید.";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function validateStep2(): boolean {
    const newErrors: Record<string, string> = {};
    if (!title.trim()) {
      newErrors.title = "لطفاً عنوان درخواست را وارد کنید.";
    }
    if (!movementType) {
      newErrors.movementType = "لطفاً نوع حرکت را انتخاب کنید.";
    }
    if (!animationDescription.trim()) {
      newErrors.animationDescription = "لطفاً توضیح دهید نقاشی چگونه متحرک شود.";
    }
    if (!duration) {
      newErrors.duration = "لطفاً مدت تقریبی انیمیشن را انتخاب کنید.";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setDrawingFileName(file.name);
    }
  }

  function clearFile() {
    setDrawingFileName(null);
  }

  function handleContinueToDetails() {
    if (validateStep1()) {
      setStep(2);
      setErrors({});
    }
  }

  function handleBackToDrawing() {
    setStep(1);
  }

  function handleGoToReview() {
    if (validateStep2()) {
      setStep(3);
      setErrors({});
    }
  }

  function handleBackToDetails() {
    setStep(2);
  }

  function handleSaveDraftAndGoToSignup() {
    const currentCost = costResult?.available === true ? costResult.candyCost : 0
    const draft: DrawingCreationDraft = {
      version: 1,
      createdAt: new Date().toISOString(),
      estimatedCandyCost: currentCost,
      type: "drawing",
      drawingFileName: drawingFileName!,
      title,
      movementType,
      animationDescription,
      backgroundScene: backgroundScene || "",
      duration: duration as "کوتاه" | "متوسط" | "بلند",
      parentNote: parentNote || "",
    };
    saveCreationDraft(draft);
    router.push("/signup");
  }

  const inputClass =
    "w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30";

  return (
    <div>
      <PageHeader
        title="متحرک‌سازی نقاشی کودک"
        description="نقاشی کودک را برای تبدیل به یک انیمیشن کوتاه آماده کنید. ثبت و ارسال نهایی پس از ورود یا ساخت حساب انجام می‌شود."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-2">نقاشی کودک خصوصی می‌ماند</h3>
        <p className="text-sm text-text-dark/70">
          نقاشی و اطلاعات این فرم تا پیش از ثبت نهایی درخواست ذخیره دائمی نمی‌شود.
          پس از تأیید والدین، فایل‌ها فقط برای والد و تیم کارتونا قابل مشاهده خواهند بود.
        </p>
      </Card>

      <CreationTypeSwitcher activeType="drawing" />

      <div className="mb-6" role="navigation" aria-label="مراحل متحرک‌سازی">
        <ol className="flex items-center">
          {stepLabels.map((label, index) => {
            const stepNum = index + 1;
            const isCurrent = stepNum === step;
            const isPast = stepNum < step;
            return (
              <li key={label} className="flex items-center flex-1">
                <div
                  className={`flex items-center justify-center rounded-full w-8 h-8 text-sm font-medium shrink-0 ${
                    isCurrent
                      ? "bg-candy-pink text-white"
                      : isPast
                        ? "bg-mint-green/20 text-mint-green"
                        : "bg-soft-border text-text-dark/50"
                  }`}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {isPast ? "✓" : stepNum}
                </div>
                <span
                  className={`mr-2 text-xs font-medium ${
                    isCurrent ? "text-parent-navy" : "text-text-dark/50"
                  }`}
                >
                  {label}
                </span>
                {index < stepLabels.length - 1 && (
                  <div
                    className={`flex-1 h-px mx-3 ${
                      isPast ? "bg-mint-green/50" : "bg-soft-border"
                    }`}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {step === 1 && (
        <Card className="mb-6">
          <h2 className="mb-2 font-semibold text-parent-navy">انتخاب نقاشی کودک</h2>
          <p className="mb-4 text-xs text-text-dark/60">تصویر نقاشی کودک را برای متحرک‌سازی انتخاب کنید.</p>
          {errors.drawing && (
            <p className="mb-3 text-sm text-coral" role="alert">{errors.drawing}</p>
          )}
          {drawingFileName ? (
            <div className="flex items-center gap-3 rounded-lg border border-candy-pink bg-candy-pink/5 px-3 py-3 text-sm">
              <span className="flex-1 text-text-dark font-medium truncate">{drawingFileName}</span>
              <span className="shrink-0 text-sm font-medium text-candy-pink">انتخاب شده</span>
              <button
                type="button"
                onClick={clearFile}
                className="text-xs text-coral hover:opacity-80 shrink-0"
              >
                حذف
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/50">
                فایل در این مرحله ارسال یا ذخیره نمی‌شود.
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-candy-pink hover:opacity-80 self-start">
                انتخاب نقاشی
                <input
                  id="drawingFile"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleFileSelect}
                  className="sr-only"
                />
              </label>
            </div>
          )}
        </Card>
      )}

      {step === 2 && (
        <Card className="mb-6">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="title">
                عنوان درخواست <span className="text-coral">*</span>
              </label>
              <input
                id="title"
                type="text"
                placeholder="مثلا: اسب کوچک من"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={inputClass}
              />
              {errors.title && <p className="mt-1 text-sm text-coral" role="alert">{errors.title}</p>}
            </div>

            <fieldset className="space-y-2">
              <legend className="block text-sm font-medium text-text-dark">
                نوع حرکت <span className="text-coral">*</span>
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {movementOptions.map((opt) => {
                  const isSelected = movementType === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className={`cursor-pointer rounded-lg border p-3 text-center text-xs transition-colors ${
                        isSelected
                          ? "border-candy-pink bg-candy-pink/5 font-medium text-parent-navy"
                          : "border-soft-border bg-soft-border/5 text-text-dark/60 hover:border-text-dark/30"
                      }`}
                    >
                      <input
                        type="radio"
                        name="movementType"
                        value={opt.value}
                        checked={isSelected}
                        onChange={() => setMovementType(opt.value)}
                        className="sr-only"
                      />
                      {opt.label}
                      {isSelected && (
                        <span className="block mt-1 text-candy-pink text-[10px]">انتخاب شده</span>
                      )}
                    </label>
                  );
                })}
              </div>
              {errors.movementType && (
                <p className="text-sm text-coral" role="alert">{errors.movementType}</p>
              )}
            </fieldset>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="animationDescription">
                توضیح نحوه متحرک‌سازی <span className="text-coral">*</span>
              </label>
              <textarea
                id="animationDescription"
                placeholder="متن خود را اینجا بنویسید"
                value={animationDescription}
                onChange={(e) => setAnimationDescription(e.target.value)}
                className={`${inputClass} min-h-[80px]`}
              />
              {errors.animationDescription && (
                <p className="mt-1 text-sm text-coral" role="alert">{errors.animationDescription}</p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-dark" htmlFor="backgroundScene">
                  پس‌زمینه یا صحنه
                </label>
                <input
                  id="backgroundScene"
                  type="text"
                  placeholder="مثلا: چمنزار، جنگل، اتاق"
                  value={backgroundScene}
                  onChange={(e) => setBackgroundScene(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-dark">
                  مدت تقریبی انیمیشن <span className="text-coral">*</span>
                </label>
                <fieldset className="flex gap-2">
                  {durationOptions.map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex-1 cursor-pointer rounded-lg border p-3 text-center text-sm transition-colors ${
                        duration === opt.value
                          ? "border-candy-pink bg-candy-pink/5 text-parent-navy font-medium"
                          : "border-soft-border bg-soft-border/5 text-text-dark/60 hover:border-text-dark/30"
                      }`}
                    >
                      <input
                        type="radio"
                        name="duration"
                        value={opt.value}
                        checked={duration === opt.value}
                        onChange={() => setDuration(opt.value)}
                        className="sr-only"
                      />
                      {opt.label}
                    </label>
                  ))}
                </fieldset>
                {errors.duration && (
                  <p className="mt-1 text-sm text-coral" role="alert">{errors.duration}</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="parentNote">
                یادداشت والد
              </label>
              <textarea
                id="parentNote"
                placeholder="مثلا: کودک دوست دارد نقاشی‌اش در طبیعت حرکت کند..."
                value={parentNote}
                onChange={(e) => setParentNote(e.target.value)}
                className={`${inputClass} min-h-[60px]`}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark">
                نقاشی انتخاب‌شده
              </label>
              <div className="rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark">
                {drawingFileName}
              </div>
            </div>
          </div>
        </Card>
      )}

      {step === 3 && (
        <>
          <Card className="mb-6">
            <h2 className="mb-4 font-semibold text-parent-navy">بررسی نهایی درخواست</h2>
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">نام فایل نقاشی</span>
                <span className="text-text-dark font-medium">{drawingFileName}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">عنوان درخواست</span>
                <span className="text-text-dark">{title}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">نوع حرکت</span>
                <span className="text-text-dark">{movementType}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">توضیح نحوه متحرک‌سازی</span>
                <span className="text-text-dark">{animationDescription}</span>
              </div>
              {backgroundScene && (
                <div className="flex justify-between gap-4">
                  <span className="text-text-dark/50">پس‌زمینه یا صحنه</span>
                  <span className="text-text-dark">{backgroundScene}</span>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">مدت تقریبی انیمیشن</span>
                <span className="text-text-dark">{duration}</span>
              </div>
              {parentNote && (
                <div className="flex justify-between gap-4">
                  <span className="text-text-dark/50">یادداشت والد</span>
                  <span className="text-text-dark">{parentNote}</span>
                </div>
              )}
              <div className="border-t border-soft-border pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-text-dark/50">هزینه برآوردی</span>
                  {pricingLoading ? (
                    <span className="text-sm text-text-dark/50">در حال دریافت هزینه…</span>
                  ) : pricingError || !costResult?.available ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-coral">هزینه این درخواست در حال حاضر در دسترس نیست.</span>
                      <button
                        type="button"
                        onClick={refreshPricing}
                        className="text-xs text-candy-pink hover:opacity-80"
                      >
                        تلاش دوباره
                      </button>
                    </div>
                  ) : (
                    <span className="text-xl font-bold text-text-dark">{costResult.candyCost.toLocaleString("fa-IR")} آب‌نبات</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-dark/50">
                  هزینه نهایی بر اساس قیمت زمان ثبت درخواست محاسبه می‌شود.
                </p>
              </div>
            </div>
          </Card>

          <SafetyNotice title="هنوز ثبت نشده است">
            این درخواست هنوز ثبت یا ذخیره نشده است. والد یا سرپرست قانونی پس از ورود یا ساخت حساب، ثبت نهایی را انجام می‌دهد.
            اطلاعات و فایل واردشده در این مرحله فقط در مرورگر شماست و تا زمان ثبت نهایی ذخیره دائمی نمی‌شود.
          </SafetyNotice>

          <p className="mt-4 text-center text-xs text-text-dark/50">
            جزئیات این درخواست تا پایان این تب به‌صورت موقت روی همین دستگاه نگه‌داری می‌شود تا پس از ساخت حساب ادامه دهید.
          </p>
          {drawingFileName && (
            <p className="mt-1 text-center text-xs text-text-dark/50">
              خود فایل ذخیره نمی‌شود و در مرحله ثبت نهایی باید دوباره انتخاب شود.
            </p>
          )}
        </>
      )}

      <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-4 mt-6">
        {step === 1 && (
          <>
            <Link href="/" className="text-sm text-text-dark/50 hover:text-text-dark/70">
              بازگشت به صفحه اصلی
            </Link>
            <Button onClick={handleContinueToDetails}>
              ادامه به جزئیات
            </Button>
          </>
        )}
        {step === 2 && (
          <>
            <Button variant="secondary" onClick={handleBackToDrawing}>
              بازگشت
            </Button>
            <Button onClick={handleGoToReview}>
              بررسی درخواست
            </Button>
          </>
        )}
        {step === 3 && (
          <>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleBackToDrawing}>
                تغییر نقاشی
              </Button>
              <Button variant="secondary" onClick={handleBackToDetails}>
                ویرایش جزئیات
              </Button>
            </div>
            <Button
              onClick={handleSaveDraftAndGoToSignup}
              disabled={costResult?.available !== true}
            >
              ادامه و متحرک‌سازی نقاشی
            </Button>
          </>
        )}
      </div>

      {step === 3 && (
        <div className="mt-4 text-center">
          <Link href="/" className="text-xs text-text-dark/50 hover:text-text-dark/70">
            بازگشت به صفحه اصلی
          </Link>
        </div>
      )}
    </div>
  );
}

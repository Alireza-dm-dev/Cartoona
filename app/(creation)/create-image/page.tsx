"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/neu-button";
import { Badge } from "@/components/ui/neu-badge";
import { SafetyNotice } from "@/components/ui/safety-notice";
import { CreationTypeSwitcher } from "@/components/creation/creation-type-switcher";
import { useCreationPricing } from "@/lib/pricing/use-creation-pricing";
import { calculateCreationCost } from "@/lib/pricing/calculate-creation-cost";
import { saveCreationDraft } from "@/lib/creation/creation-draft";
import type { ImageCreationDraft } from "@/lib/creation/creation-draft";
import { characters } from "@/config/characters";
import { PresetChips } from "@/components/creation/preset-chips";
import {
  CHILD_NAME_LABEL,
  CHILD_NAME_MAX_LENGTH,
  CHILD_NAME_PLACEHOLDER,
  checkChildName,
  normalizeChildName,
} from "@/lib/creation/child-name";
import {
  IMAGE_OCCASION_PRESETS,
  IMAGE_SCENE_PRESETS,
  IMAGE_STYLE_PRESETS,
} from "@/lib/creation/creation-presets";

const categoryLabels: Record<string, string> = {
  Adventure: "ماجراجویی",
  Fantasy: "فانتازی",
  Animals: "حیوانات",
  "Sci-Fi": "علمی-تخیلی",
  Education: "آموزشی",
};

const stepLabels = ["انتخاب شخصیت", "جزئیات تصویر", "بررسی نهایی"];

export default function CreateImagePage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [sceneDescription, setSceneDescription] = useState("");
  const [style, setStyle] = useState("");
  const [occasion, setOccasion] = useState("");
  const [parentNote, setParentNote] = useState("");
  const [referenceFileName, setReferenceFileName] = useState<string | null>(null);
  const [childName, setChildName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { catalog, loading: pricingLoading, error: pricingError, refresh: refreshPricing } = useCreationPricing();

  const selectedCharacter = characters.find((c) => c.name === selectedCharacterId);

  const costResult = catalog
    ? calculateCreationCost(catalog, "image", null, Boolean(referenceFileName))
    : null;

  // Review and draft both show the stored form of the name, not the raw field.
  // Step 2 cannot be passed with an unusable name, so by review time this is
  // either a real name or null.
  const normalizedChildName = normalizeChildName(childName);

  function validateStep1(): boolean {
    const newErrors: Record<string, string> = {};
    if (!selectedCharacterId) {
      newErrors.character = "لطفاً یک شخصیت را انتخاب کنید.";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function validateStep2(): boolean {
    const newErrors: Record<string, string> = {};
    if (!sceneDescription.trim()) {
      newErrors.sceneDescription = "لطفاً توضیح صحنه را وارد کنید.";
    }
    if (!style.trim()) {
      newErrors.style = "لطفاً سبک تصویر را وارد کنید.";
    }
    // Optional: an empty field passes. Only a filled-in but unusable name
    // stops the step.
    const child = checkChildName(childName);
    if (!child.ok) {
      newErrors.childName = child.message;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setReferenceFileName(file.name);
    }
  }

  function clearFile() {
    setReferenceFileName(null);
  }

  function handleContinueToDetails() {
    if (validateStep1()) {
      setStep(2);
      setErrors({});
    }
  }

  function handleBackToCharacter() {
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
    const draft: ImageCreationDraft = {
      version: 1,
      createdAt: new Date().toISOString(),
      estimatedCandyCost: currentCost,
      type: "image",
      selectedCharacterId: selectedCharacterId!,
      sceneDescription,
      style,
      occasion: occasion || "",
      parentNote: parentNote || "",
      referenceFileName: referenceFileName || "",
      // Normalized before it is stored, so the draft carries the same string
      // the database will, and null rather than "" when it was left blank.
      childName: normalizedChildName,
    };
    saveCreationDraft(draft);
    router.push("/signup");
  }

  const inputClass =
    "neu-recessed w-full rounded-xl px-3 py-2 text-sm outline-none transition-shadow";

  return (
    <div>
      <PageHeader
        title="ساخت تصویر کارتونی"
        description="ابتدا ایده و گزینه‌های خود را وارد کنید. برای ثبت نهایی درخواست، در مرحله آخر وارد حساب شوید یا حساب والدین بسازید."
      />

      <Card className="mb-6 border-soft-purple/20 bg-soft-purple/5">
        <h3 className="font-semibold text-parent-navy mb-2">خصوصی و تحت کنترل والدین</h3>
        <p className="text-sm text-text-dark/70">
          اطلاعات این فرم تا پیش از ثبت نهایی درخواست ذخیره دائمی نمی‌شود.
          پس از تأیید والدین، درخواست به‌صورت خصوصی ثبت خواهد شد.
        </p>
      </Card>

      <CreationTypeSwitcher activeType="image" />

      <div className="mb-6" role="navigation" aria-label="مراحل ساخت تصویر">
        <ol className="flex items-center">
          {stepLabels.map((label, index) => {
            const stepNum = index + 1;
            const isCurrent = stepNum === step;
            const isPast = stepNum < step;
            return (
              <li key={label} className="flex items-center flex-1">
                <div
                  className={`flex items-center justify-center rounded-full w-8 h-8 text-sm font-medium shrink-0 transition-all ${
                    isCurrent
                      ? "bg-candy-pink text-white shadow-[-2px_-2px_5px_rgba(255,255,255,0.6),2px_2px_7px_rgba(214,60,120,0.4)]"
                      : isPast
                        ? "bg-mint-green/25 text-emerald-800 shadow-[-2px_-2px_5px_rgba(255,255,255,0.7),2px_2px_6px_rgba(150,110,70,0.15)]"
                        : "bg-[var(--neu-surface-recessed)] text-text-dark/40 shadow-[inset_1px_1px_3px_rgba(150,110,70,0.18),inset_-1px_-1px_3px_rgba(255,255,255,0.7)]"
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
          <h2 className="mb-2 font-semibold text-parent-navy">انتخاب شخصیت کارتونا</h2>
          <p className="mb-4 text-xs text-text-dark/60">مجموعه شخصیت‌های اصلی کارتونا — یکی را انتخاب کنید.</p>
          {errors.character && (
            <p className="mb-3 text-sm text-coral" role="alert">{errors.character}</p>
          )}
          <div className="grid gap-3" role="radiogroup" aria-label="شخصیت‌ها">
            {characters.map((character) => {
              const isSelected = selectedCharacterId === character.name;
              return (
                <label
                  key={character.name}
                  className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? "neu-pressed-pink font-medium"
                      : "neu-raised neu-interactive text-text-dark/80"
                  }`}
                >
                  <input
                    type="radio"
                    name="character"
                    value={character.name}
                    checked={isSelected}
                    onChange={() => setSelectedCharacterId(character.name)}
                    className="sr-only"
                  />
                  <span className="text-2xl shrink-0">{character.emoji}</span>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-text-dark">{character.name}</h3>
                      <Badge variant="default" size="sm">
                        {categoryLabels[character.category] || character.category}
                      </Badge>
                    </div>
                    <p className="text-xs text-text-dark/60 mt-0.5">
                      {character.description}
                    </p>
                  </div>
                  {isSelected && (
                    <span className="shrink-0 text-sm font-medium text-candy-pink">
                      انتخاب شده
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card className="mb-6">
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="sceneDescription">
                توضیح صحنه <span className="text-coral">*</span>
              </label>
              <PresetChips
                presets={IMAGE_SCENE_PRESETS}
                value={sceneDescription}
                onSelect={setSceneDescription}
                label="یکی را انتخاب کنید یا خودتان بنویسید"
                idPrefix="scene"
              />
              <textarea
                id="sceneDescription"
                placeholder="متن خود را اینجا بنویسید"
                value={sceneDescription}
                onChange={(e) => setSceneDescription(e.target.value)}
                className={`${inputClass} min-h-[80px]`}
              />
              {errors.sceneDescription && (
                <p className="mt-1 text-sm text-coral" role="alert">{errors.sceneDescription}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="style">
                سبک تصویر <span className="text-coral">*</span>
              </label>
              <PresetChips
                presets={IMAGE_STYLE_PRESETS}
                value={style}
                onSelect={setStyle}
                label="یکی را انتخاب کنید یا خودتان بنویسید"
                idPrefix="style"
              />
              <input
                id="style"
                type="text"
                placeholder="مثلا: رویاگونه، کارتونی نرم"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className={inputClass}
              />
              {errors.style && <p className="mt-1 text-sm text-coral" role="alert">{errors.style}</p>}
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="occasion">
                مناسبت یا موضوع
              </label>
              <PresetChips
                presets={IMAGE_OCCASION_PRESETS}
                value={occasion}
                onSelect={setOccasion}
                label="اختیاری — یکی را انتخاب کنید یا خودتان بنویسید"
                idPrefix="occasion"
              />
              <input
                id="occasion"
                type="text"
                placeholder="مثلا: شب تابستانی، تولد"
                value={occasion}
                onChange={(e) => setOccasion(e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="parentNote">
                یادداشت والد
              </label>
              <textarea
                id="parentNote"
                placeholder="مثلا: کودک دوست دارد پروانه‌ها ببیند..."
                value={parentNote}
                onChange={(e) => setParentNote(e.target.value)}
                className={`${inputClass} min-h-[60px]`}
              />
            </div>

            {/* Child name sits directly above the reference upload: the two
                describe the same child, and a parent who uploads a photo is
                the parent most likely to want the name attached to it. */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="childName">
                {CHILD_NAME_LABEL}
              </label>
              <input
                id="childName"
                type="text"
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                placeholder={CHILD_NAME_PLACEHOLDER}
                maxLength={CHILD_NAME_MAX_LENGTH}
                autoComplete="off"
                aria-invalid={errors.childName ? true : undefined}
                aria-describedby="childName-hint"
                className={inputClass}
              />
              <p id="childName-hint" className="text-xs text-text-dark/50">
                اختیاری — برای شخصی‌سازی تصویر استفاده می‌شود.
              </p>
              {errors.childName && (
                <p className="mt-1 text-sm text-coral" role="alert">{errors.childName}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-dark" htmlFor="referenceFile">
                فایل مرجع کودک / تصویر کمکی
              </label>
              {referenceFileName ? (
                <div className="neu-recessed flex items-center gap-3 rounded-xl px-3 py-2 text-sm">
                  <span className="flex-1 text-text-dark truncate">{referenceFileName}</span>
                  <button
                    type="button"
                    onClick={clearFile}
                    className="text-xs text-coral hover:opacity-80"
                  >
                    حذف
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="neu-recessed rounded-xl px-3 py-2 text-sm text-text-dark/50">
                    فایل در این مرحله ارسال یا ذخیره نمی‌شود.
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-candy-pink hover:opacity-80 self-start">
                    انتخاب فایل
                    <input
                      id="referenceFile"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleFileSelect}
                      className="sr-only"
                    />
                  </label>
                </div>
              )}
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
                <span className="text-text-dark/50">شخصیت انتخاب‌شده</span>
                <span className="text-text-dark font-medium">
                  {selectedCharacter?.emoji} {selectedCharacter?.name}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">توضیح صحنه</span>
                <span className="text-text-dark">{sceneDescription}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-text-dark/50">سبک</span>
                <span className="text-text-dark">{style}</span>
              </div>
              {occasion && (
                <div className="flex justify-between gap-4">
                  <span className="text-text-dark/50">مناسبت</span>
                  <span className="text-text-dark">{occasion}</span>
                </div>
              )}
              {parentNote && (
                <div className="flex justify-between gap-4">
                  <span className="text-text-dark/50">یادداشت والد</span>
                  <span className="text-text-dark">{parentNote}</span>
                </div>
              )}
              {normalizedChildName && (
                <div className="flex justify-between gap-4">
                  <span className="text-text-dark/50">{CHILD_NAME_LABEL}</span>
                  <span className="text-text-dark">{normalizedChildName}</span>
                </div>
              )}
              {referenceFileName && (
                <div className="flex justify-between gap-4">
                  <span className="text-text-dark/50">فایل مرجع</span>
                  <span className="text-text-dark">{referenceFileName}</span>
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
            اطلاعات واردشده در این مرحله فقط در مرورگر شماست و تا زمان ثبت نهایی ذخیره دائمی نمی‌شود.
          </SafetyNotice>

          <p className="mt-4 text-center text-xs text-text-dark/50">
            جزئیات این درخواست تا پایان این تب به‌صورت موقت روی همین دستگاه نگه‌داری می‌شود تا پس از ساخت حساب ادامه دهید.
          </p>
          {referenceFileName && (
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
            <Button variant="secondary" onClick={handleBackToCharacter}>
              بازگشت
            </Button>
            <Button onClick={handleGoToReview}>
              بررسی درخواست
            </Button>
          </>
        )}
        {step === 3 && (
          <>
            <Button variant="secondary" onClick={handleBackToDetails}>
              ویرایش جزئیات
            </Button>
            <Button
              onClick={handleSaveDraftAndGoToSignup}
              disabled={costResult?.available !== true}
            >
              ادامه و ساخت تصویر
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

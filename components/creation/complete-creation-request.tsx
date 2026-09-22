"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { clearCreationDraft, readCreationDraft } from "@/lib/creation/creation-draft";
import type { CreationDraft, ImageCreationDraft, VideoCreationDraft, DrawingCreationDraft } from "@/lib/creation/creation-draft";
import { CreationDraftSummaryCard } from "@/components/creation/pending-creation-draft-card";
import { PrivateGalleryPicker } from "@/components/creation/private-gallery-picker";
import type { ParentGalleryMedia } from "@/lib/parent/gallery/types";
import { PARENT_PORTAL_HOME } from "@/lib/parent/navigation/parent-nav";
import { useCreationPricing } from "@/lib/pricing/use-creation-pricing";
import { calculateCreationCost } from "@/lib/pricing/calculate-creation-cost";
import { FORM_TO_INTERNAL, VIDEO_DURATION_TO_INTERNAL, isVideoDurationChoice } from "@/lib/pricing/pricing-keys";
import {
  buildRequestFormData,
  checkUploadFile,
  classifySubmissionError,
  readCreatedOrderId,
} from "@/lib/requests/submission-client";
import type { SubmitErrorKind } from "@/lib/requests/submission-client";
import type { InternalDuration } from "@/lib/pricing/pricing-keys";

const imageAcceptedTypes = "image/png,image/jpeg,image/webp";
const videoReferenceAcceptedTypes = "image/png,image/jpeg,image/webp,video/mp4,video/webm";

const imageAcceptedMimeTypes = ["image/png", "image/jpeg", "image/webp"];
const videoReferenceAcceptedMimeTypes = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"];

/**
 * Where the submission has got to.
 *
 * "success" is terminal and is held until the redirect lands, so the button
 * cannot be pressed again during the navigation that follows a created order.
 */
type SubmitPhase = "idle" | "submitting" | "success";

interface SubmitError {
  kind: SubmitErrorKind;
  message: string;
}

export default function CompleteCreationRequest() {
  const [draft, setDraft] = useState<CreationDraft | null>(null);
  const [hasFinishedLoading, setHasFinishedLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // A source can come from the device or from the parent's private gallery.
  // Only one of the two is ever active, so a request cannot carry both.
  const [sourceMode, setSourceMode] = useState<"upload" | "gallery">("upload");
  const [selectedGalleryMedia, setSelectedGalleryMedia] =
    useState<ParentGalleryMedia | null>(null);
  const [fileError, setFileError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  /**
   * Guards against a second submission starting before the first has
   * answered. React state is not enough on its own: two clicks in the same
   * tick both read the old state, and each created order costs real candy.
   */
  const inFlight = useRef(false);
  /**
   * The idempotency key for the current logical submit attempt.
   *
   * Minted once, on the first submit, and reused unchanged across every
   * retry of that same attempt — including a retry after a timeout or a lost
   * response, which is exactly the case client-side in-flight locking cannot
   * cover by itself. Cleared only when the parent materially changes the
   * source file (a new logical submission) or after a confirmed success.
   */
  const submissionKeyRef = useRef<string | null>(null);
  const router = useRouter();

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
      const dur: InternalDuration | null = isVideoDurationChoice(d) ? VIDEO_DURATION_TO_INTERNAL[d] : null
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
              href={PARENT_PORTAL_HOME}
              className="text-xs text-text-dark/50 hover:text-text-dark/70"
            >
              رفتن به درخواست‌ها
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

  const fileSelected = selectedFile !== null || selectedGalleryMedia !== null;

  const fileRequiredAndMissing = requiresFileReselection && !fileSelected;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError("");
    const file = e.target.files?.[0];
    if (!file) return;

    const check = checkUploadFile(file, acceptedMimeTypes);
    if (!check.ok) {
      setFileError(check.message);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    setSelectedGalleryMedia(null);
    setSelectedFile(file);
    // A new source file is a new logical submission: the next submit gets a
    // fresh key rather than one tied to whatever the previous file was.
    submissionKeyRef.current = null;
  }

  function handleRemoveFile() {
    setSelectedFile(null);
    setSelectedGalleryMedia(null);
    setFileError("");
    setSubmitError(null);
    submissionKeyRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  /**
   * Record an explicit choice from the private gallery.
   *
   * Only the asset id travels with the request. The storage path is never sent
   * by the browser — the server resolves it from a row it has proven belongs
   * to this parent.
   */
  function handleGallerySelect(media: ParentGalleryMedia) {
    setFileError("");
    setSubmitError(null);
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setSelectedGalleryMedia(media);
    // A new source choice is a new logical submission.
    submissionKeyRef.current = null;
  }

  function handleUseUpload() {
    setSourceMode("upload");
    setSelectedGalleryMedia(null);
  }

  /**
   * Send the request.
   *
   * Everything that decides the outcome — the price, the candy debit, who owns
   * the selected gallery asset, whether consent was granted — is settled on the
   * server. This function's whole job is to hand over the draft and at most one
   * source, then act on the answer. It deliberately computes no price and
   * trusts none of the numbers already on screen.
   */
  async function handleSubmit(): Promise<void> {
    if (inFlight.current || phase !== "idle") return;
    if (!draft) return;
    if (fileRequiredAndMissing) return;

    inFlight.current = true;
    setSubmitError(null);
    setPhase("submitting");

    // Every failure goes through here, so the in-flight lock cannot be left
    // held by a path that forgot to release it. Success deliberately does not
    // release: the component is on its way off screen.
    const fail = (error: SubmitError) => {
      inFlight.current = false;
      setSubmitError(error);
      setPhase("idle");
    };

    try {
      // Minted once per logical submission and kept for every retry — a
      // timed-out response must not cause a second order, so the key does
      // not regenerate just because this is not the first attempt.
      if (!submissionKeyRef.current) {
        submissionKeyRef.current = crypto.randomUUID();
      }
      const submissionKey = submissionKeyRef.current;

      // At most one source. The two pieces of state are already mutually
      // exclusive; the builder refuses the impossible case rather than picking.
      const built = buildRequestFormData(draft, submissionKey, {
        file: selectedFile,
        galleryAssetId: selectedGalleryMedia?.id ?? null,
      });

      if (!built.ok) {
        fail({
          kind: "validation",
          message: "برای هر درخواست فقط یک فایل مجاز است: یا بارگذاری جدید، یا انتخاب از گالری.",
        });
        return;
      }

      const res = await fetch("/api/requests", { method: "POST", body: built.formData });

      // An expired or missing session is not an error to render in place —
      // the parent needs the login flow, and the existing guard on
      // /complete-request will bring them back here afterwards.
      if (res.status === 401) {
        window.location.assign("/login?reason=session_expired&from=/complete-request");
        return;
      }

      if (res.status === 403) {
        window.location.assign("/parent-consent");
        return;
      }

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        fail({
          kind: classifySubmissionError(res.status, body?.code),
          message:
            typeof body?.error === "string" && body.error.length > 0
              ? body.error
              : "ثبت درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.",
        });
        return;
      }

      const orderId = readCreatedOrderId(body);
      if (!orderId) {
        // The order may well exist; what is missing is a place to send the
        // parent. The draft is kept so nothing they typed is lost.
        fail({
          kind: "request",
          message: "ثبت درخواست با خطا مواجه شد. لطفاً سفارش‌های خود را بررسی کنید.",
        });
        return;
      }

      // Only now, with a real order id in hand, is the draft safe to discard.
      // Clearing it any earlier would lose the parent's work on a failure.
      setPhase("success");
      submissionKeyRef.current = null;
      clearCreationDraft();
      router.push(`/dashboard/orders/${orderId}`);
    } catch {
      fail({
        kind: "request",
        message: "ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.",
      });
    }
  }

  function getReadinessText(): string {
    if (fileRequiredAndMissing) {
      return "برای ادامه، ابتدا فایل لازم را دوباره انتخاب کنید.";
    }
    return "با ثبت نهایی، هزینه این درخواست از موجودی آب‌نبات شما کسر می‌شود.";
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
                    {selectedFile
                      ? selectedFile.name
                      : (selectedGalleryMedia?.label ?? "فایل انتخاب‌شده از گالری")}
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
                  {selectedGalleryMedia
                    ? "این فایل از گالری خصوصی شما انتخاب شد و برای این درخواست استفاده می‌شود."
                    : "آماده برای مرحله ثبت نهایی"}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/* Two ways to provide the source. The parent is authenticated
                    here, so the gallery is safe to offer — the public creation
                    pages stay anonymous and are not changed. */}
                <div className="flex flex-wrap gap-2" role="group" aria-label="روش انتخاب فایل">
                  <button
                    type="button"
                    onClick={handleUseUpload}
                    aria-pressed={sourceMode === "upload"}
                    className={`min-h-[44px] rounded-lg border px-3 text-sm font-medium transition-colors ${
                      sourceMode === "upload"
                        ? "border-candy-pink text-candy-pink"
                        : "border-soft-border text-text-dark/70"
                    }`}
                  >
                    آپلود تصویر جدید
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceMode("gallery")}
                    aria-pressed={sourceMode === "gallery"}
                    className={`min-h-[44px] rounded-lg border px-3 text-sm font-medium transition-colors ${
                      sourceMode === "gallery"
                        ? "border-candy-pink text-candy-pink"
                        : "border-soft-border text-text-dark/70"
                    }`}
                  >
                    انتخاب از گالری خصوصی
                  </button>
                </div>

                {sourceMode === "upload" ? (
                  <div className="flex flex-col gap-2">
                    <div className="rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-text-dark/50">
                      فایل فقط در حافظه همین صفحه نگه‌داری می‌شود و هنوز بارگذاری
                      نشده است.
                    </div>
                    <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-sm font-medium text-candy-pink hover:opacity-80 self-start">
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
                ) : (
                  /* Nothing is selected while the picker is on screen:
                     choosing an item moves this card into its confirmation
                     state, which is where the parent confirms the reuse. */
                  <PrivateGalleryPicker
                    selectedId={null}
                    onSelect={handleGallerySelect}
                    onCancel={handleUseUpload}
                  />
                )}
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
          با تأیید شما، درخواست ثبت می‌شود و هزینه آن از موجودی آب‌نبات شما کسر
          می‌گردد.
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
          تا زمانی که دکمه «ثبت نهایی درخواست» را نزده‌اید، هیچ سفارشی ثبت
          نمی‌شود و آب‌نباتی کسر نمی‌شود.
        </p>

        {submitError && (
          <div
            className="mt-4 rounded-lg border border-coral/30 bg-coral/5 px-3 py-3"
            role="alert"
            aria-live="assertive"
          >
            <p className="text-sm text-coral">{submitError.message}</p>

            {/* Each failure that has a way forward offers it. The rest are
                simply retried with the button below. */}
            {submitError.kind === "insufficient_candy" && (
              <Link
                href="/dashboard/billing"
                className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-candy-pink hover:opacity-80"
              >
                افزایش موجودی آب‌نبات
              </Link>
            )}
            {submitError.kind === "gallery" && (
              <p className="mt-1 text-xs text-text-dark/60">
                لطفاً فایل دیگری از گالری انتخاب کنید یا فایل جدیدی بارگذاری کنید.
              </p>
            )}
            {submitError.kind === "upload" && (
              <p className="mt-1 text-xs text-text-dark/60">
                لطفاً فایل را دوباره انتخاب کنید.
              </p>
            )}
            {submitError.kind === "pricing" && (
              <button
                type="button"
                onClick={refreshPricing}
                className="mt-2 min-h-[44px] text-sm text-candy-pink hover:opacity-80"
              >
                تلاش دوباره برای دریافت هزینه
              </button>
            )}
          </div>
        )}

        <div className="mt-6">
          <Button
            className="w-full min-h-[44px]"
            onClick={handleSubmit}
            disabled={fileRequiredAndMissing || phase !== "idle"}
            aria-busy={phase === "submitting"}
          >
            {phase === "submitting"
              ? "در حال ثبت درخواست…"
              : phase === "success"
                ? "ثبت شد — در حال انتقال…"
                : "ثبت نهایی درخواست"}
          </Button>

          {/* aria-live so the state change is announced, not only shown. */}
          <p className="mt-2 text-center text-xs text-text-dark/40" aria-live="polite">
            {phase === "submitting"
              ? "در حال بارگذاری فایل و ثبت درخواست. لطفاً این صفحه را نبندید."
              : phase === "success"
                ? "درخواست شما ثبت شد. در حال انتقال به صفحه سفارش…"
                : getReadinessText()}
          </p>
        </div>

        <div className="mt-4 text-center">
          <Link
            href={PARENT_PORTAL_HOME}
            className="text-sm text-text-dark/50 hover:text-text-dark/70"
          >
            بازگشت به درخواست‌ها
          </Link>
        </div>
      </Card>
    </div>
  );
}

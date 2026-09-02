"use client";

import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { readCreationDraft } from "@/lib/creation/creation-draft";
import type { CreationDraft } from "@/lib/creation/creation-draft";
import { characters } from "@/config/characters";

export type PendingCreationDraftStage = "signup" | "consent" | "completion";

const stageDescriptions: Record<PendingCreationDraftStage, string> = {
  signup:
    "جزئیات ساخت شما به‌صورت موقت در همین تب نگه‌داری شده است. پس از ساخت حساب می‌توانید ثبت درخواست را ادامه دهید.",
  consent:
    "جزئیات ساخت شما همچنان در همین تب نگه‌داری شده است. پس از تأیید رضایت والد می‌توانید ثبت درخواست را ادامه دهید.",
  completion:
    "جزئیات ساخت شما آماده بررسی نهایی است. هنوز هیچ درخواستی ثبت نشده و در این مرحله فقط پیش‌نویس موقت را مشاهده می‌کنید.",
};

function renderRow(label: string, value: string) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-text-dark/50 shrink-0">{label}</span>
      <span className="text-text-dark font-medium text-left">{value}</span>
    </div>
  );
}

function formatTimestamp(createdAt: string): string | null {
  try {
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("fa-IR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export interface CreationDraftSummaryCardProps {
  draft: CreationDraft;
  stage: PendingCreationDraftStage;
  currentCandyCost?: number | null;
}

export function CreationDraftSummaryCard({
  draft,
  stage,
  currentCandyCost,
}: CreationDraftSummaryCardProps) {
  return (
    <Card className="border-candy-pink/30 bg-candy-pink/5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold text-parent-navy">
          درخواست شما آماده ادامه است
        </h2>
        <Badge variant="info" size="sm">
          {draft.type === "image"
            ? "تصویر کارتونی"
            : draft.type === "video"
              ? "ویدیوی کارتونی"
              : "متحرک‌سازی نقاشی"}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-text-dark/60">
        {stageDescriptions[stage]}
      </p>

      <div className="mt-4 space-y-2">
        {renderRow("عنوان درخواست", draft.title)}

        {draft.type === "image" &&
          (() => {
            const c = characters.find(
              (ch) => ch.name === draft.selectedCharacterId,
            );
            return (
              <>
                {renderRow(
                  "شخصیت",
                  c ? `${c.emoji} ${c.name}` : "شخصیت انتخاب‌شده",
                )}
                {renderRow("سبک", draft.style)}
                {draft.referenceFileName &&
                  renderRow("فایل مرجع", draft.referenceFileName)}
              </>
            );
          })()}

        {draft.type === "video" &&
          (() => {
            const c = characters.find(
              (ch) => ch.name === draft.selectedCharacterId,
            );
            return (
              <>
                {renderRow(
                  "شخصیت",
                  c ? `${c.emoji} ${c.name}` : "شخصیت انتخاب‌شده",
                )}
                {renderRow("مدت", draft.duration)}
                {draft.referenceFileName &&
                  renderRow("فایل مرجع", draft.referenceFileName)}
              </>
            );
          })()}

        {draft.type === "drawing" && (
          <>
            {renderRow("نقاشی", draft.drawingFileName)}
            {renderRow("نوع حرکت", draft.movementType)}
            {renderRow("مدت", draft.duration)}
          </>
        )}

        {renderRow(
          "هزینه برآوردی",
          currentCandyCost !== undefined && currentCandyCost !== null
            ? `${currentCandyCost.toLocaleString("fa-IR")} آب‌نبات`
            : `${draft.estimatedCandyCost.toLocaleString("fa-IR")} آب‌نبات`,
        )}

        {(() => {
          const formatted = formatTimestamp(draft.createdAt);
          if (!formatted) return null;
          return renderRow("زمان ایجاد پیش‌نویس", formatted);
        })()}
      </div>

      {(draft.type === "image" || draft.type === "video") &&
        draft.referenceFileName && (
          <p className="mt-3 text-xs text-text-dark/40">
            نام فایل حفظ شده است، اما خود فایل ذخیره نشده و هنگام ثبت نهایی
            باید دوباره انتخاب شود.
          </p>
        )}
      {draft.type === "drawing" && draft.drawingFileName && (
        <p className="mt-3 text-xs text-text-dark/40">
          نام فایل حفظ شده است، اما خود فایل ذخیره نشده و هنگام ثبت نهایی باید
          دوباره انتخاب شود.
        </p>
      )}

      <p className="mt-2 text-xs text-text-dark/40">
        این اطلاعات فقط به‌صورت موقت در همین تب مرورگر نگه‌داری می‌شود و هنوز
        به‌عنوان درخواست نهایی ثبت نشده است.
      </p>
    </Card>
  );
}

export default function PendingCreationDraftCard({
  stage,
}: {
  stage: PendingCreationDraftStage;
}) {
  const [draft, setDraft] = useState<CreationDraft | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDraft(readCreationDraft());
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  if (!draft) return null;

  return <CreationDraftSummaryCard draft={draft} stage={stage} />;
}

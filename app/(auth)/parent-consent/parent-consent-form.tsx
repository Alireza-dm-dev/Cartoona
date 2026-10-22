"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/neu-button";
import PendingCreationDraftCard from "@/components/creation/pending-creation-draft-card";
import { readCreationDraft } from "@/lib/creation/creation-draft";
import { readParentConsent } from "@/lib/parent/consent/consent-client";

/**
 * The consent form (V0.1.48). The page (server) has already read consent from
 * PostgreSQL and passes `initiallyGranted`.
 *
 * After a submit, only the server's answer decides what happens:
 *   200                          saved -> continue (draft -> /complete-request, else /dashboard)
 *   503 consent_outcome_unknown  the write may have been saved: say so (never
 *   or no answer at all          "failed"), and offer "check status", which
 *                                re-reads consent; granted -> continue, not
 *                                granted -> the parent may submit again (a new
 *                                request, new nonce; granting twice is harmless)
 *   anything else                a definite answer: not saved, or sign in again
 * Nothing is re-sent automatically.
 */

type Phase = "idle" | "submitting" | "uncertain" | "checking";

const NOT_SAVED = "ثبت رضایت والد انجام نشد. لطفاً دوباره تلاش کنید.";
const UNAVAILABLE = "این عملیات موقتاً ممکن نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.";
const OUTCOME_UNKNOWN = "نتوانستیم تأیید کنیم که رضایت شما ثبت شده است یا نه. لطفاً وضعیت را بررسی کنید و در صورت نیاز دوباره تلاش کنید.";
const STILL_UNKNOWN = "بررسی وضعیت هم انجام نشد. لطفاً چند لحظه بعد دوباره بررسی کنید.";
const NOT_YET_SAVED = "رضایت شما هنوز ثبت نشده است. می‌توانید دوباره تأیید کنید.";

function continueDestination(): string {
  return readCreationDraft() ? "/complete-request" : "/dashboard";
}

export default function ParentConsentForm({ initiallyGranted }: { initiallyGranted: boolean }) {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");

  // Already consented (PostgreSQL): continue exactly as after a successful submit.
  useEffect(() => {
    if (initiallyGranted) window.location.replace(continueDestination());
  }, [initiallyGranted]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) {
      setError("لطفاً رضایت والدین را تأیید کنید.");
      return;
    }
    setError("");
    setPhase("submitting");

    let response: Response;
    try {
      response = await fetch("/api/parent-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consentGranted: true }),
      });
    } catch {
      // The request may have reached the server; its answer did not reach us.
      setError(OUTCOME_UNKNOWN);
      setPhase("uncertain");
      return;
    }

    if (response.ok) {
      window.location.href = continueDestination();
      return;
    }

    const body = (await response.json().catch(() => ({}))) as { code?: unknown };
    if (response.status === 401) {
      window.location.href =
        body.code === "PARENT_SESSION_EXPIRED"
          ? "/login?reason=session_expired&from=/parent-consent"
          : "/login?from=/parent-consent";
      return;
    }
    if (body.code === "consent_outcome_unknown" || (response.status >= 500 && typeof body.code !== "string")) {
      setError(OUTCOME_UNKNOWN);
      setPhase("uncertain");
      return;
    }
    setError(response.status === 503 ? UNAVAILABLE : NOT_SAVED);
    setPhase("idle");
  };

  const handleCheck = async () => {
    setPhase("checking");
    const granted = await readParentConsent();
    if (granted === true) {
      window.location.href = continueDestination();
      return;
    }
    if (granted === false) {
      setError(NOT_YET_SAVED);
      setPhase("idle");
      return;
    }
    setError(STILL_UNKNOWN);
    setPhase("uncertain");
  };

  if (initiallyGranted) {
    return (
      <Card>
        <p className="text-sm text-text-dark/70" role="status">
          رضایت والدین قبلاً ثبت شده است. در حال انتقال…
        </p>
      </Card>
    );
  }

  const busy = phase === "submitting" || phase === "checking";

  return (
    <div className="space-y-4">
      <PendingCreationDraftCard stage="consent" />

      <Card>
        <h1 className="text-2xl font-brand text-parent-navy">تأیید رضایت والدین</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        برای ادامه، لطفاً تأیید کنید که والد یا سرپرست قانونی هستید و با استفاده خصوصی از اطلاعات و فایل‌های مربوط به کودک در کارتونا موافقید.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="neu-recessed rounded-xl p-4 text-sm text-text-dark/70 space-y-3">
          <ul className="space-y-2">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-candy-pink">✓</span>
              <span>من تأیید می‌کنم والد یا سرپرست قانونی کودک هستم.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-candy-pink">✓</span>
              <span>می‌دانم فایل‌ها و درخواست‌ها فقط به‌صورت خصوصی برای ساخت محتوای کارتونی استفاده می‌شوند.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-candy-pink">✓</span>
              <span>می‌دانم محتوای کودک به‌صورت عمومی منتشر نمی‌شود.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-candy-pink">✓</span>
              <span>می‌دانم در مراحل بعدی امکان درخواست حذف داده‌ها فراهم خواهد شد.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-candy-pink">✓</span>
              <span>می‌دانم این نسخه هنوز MVP آزمایشی است و ذخیره‌سازی واقعی بعداً با Supabase فعال می‌شود.</span>
            </li>
          </ul>
        </div>

        <div className="flex items-start gap-3">
          <input
            id="consent-check"
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 rounded border-soft-border text-candy-pink focus:ring-2 focus:ring-candy-pink/30"
          />
          <label htmlFor="consent-check" className="text-xs leading-relaxed text-text-dark/70 cursor-pointer select-none">
            موارد بالا را خوانده‌ام و رضایت والدین را تأیید می‌کنم.
          </label>
        </div>

        {error && (
          <p className="text-xs text-coral" role="alert" data-testid="consent-error">
            {error}
          </p>
        )}

        {phase === "uncertain" || phase === "checking" ? (
          <Button type="button" className="w-full" disabled={busy} onClick={handleCheck} data-testid="consent-check-status">
            {phase === "checking" ? "در حال بررسی..." : "بررسی وضعیت رضایت"}
          </Button>
        ) : (
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "در حال ورود..." : "تأیید و ورود به پنل والدین"}
          </Button>
        )}

        <div className="text-center">
          <a href="/signup" className="text-xs text-text-dark/50 hover:text-text-dark/70">
            بازگشت به ثبت‌نام
          </a>
        </div>
      </form>
    </Card>
    </div>
  );
}

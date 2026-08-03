"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import PendingCreationDraftCard from "@/components/creation/pending-creation-draft-card";
import { readCreationDraft } from "@/lib/creation/creation-draft";

export default function ParentConsentPage() {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) {
      setError("لطفاً رضایت والدین را تأیید کنید.");
      return;
    }
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/parent-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consentGranted: true }),
      });

      if (response.ok) {
        const pendingDraft = readCreationDraft();
        const destination = pendingDraft ? "/complete-request" : "/dashboard";
        window.location.href = destination;
      } else if (response.status === 401) {
        window.location.href = "/login?from=/parent-consent";
      } else {
        setError("ثبت رضایت والد انجام نشد. لطفاً دوباره تلاش کنید.");
      }
    } catch {
      setError("ثبت رضایت والد انجام نشد. لطفاً دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <PendingCreationDraftCard stage="consent" />

      <Card>
        <h1 className="text-2xl font-brand text-parent-navy">تأیید رضایت والدین</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        برای ادامه، لطفاً تأیید کنید که والد یا سرپرست قانونی هستید و با استفاده خصوصی از اطلاعات و فایل‌های مربوط به کودک در کارتونا موافقید.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="rounded-xl border border-soft-border bg-cream/50 p-4 text-sm text-text-dark/70 space-y-3">
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

        {error && <p className="text-xs text-coral">{error}</p>}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "در حال ورود..." : "تأیید و ورود به پنل والدین"}
        </Button>

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

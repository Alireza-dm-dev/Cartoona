"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import PendingCreationDraftCard from "@/components/creation/pending-creation-draft-card";

function normalizeIranPhone(raw: string): string {
  const persian: Record<string, string> = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  };
  const converted = raw.replace(/[۰-۹٠-٩]/g, (ch) => persian[ch] || ch);
  const cleaned = converted.replace(/[\s\-()]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  let national: string;
  if (digits.startsWith("0098")) {
    national = digits.slice(4);
  } else if (digits.startsWith("98") && digits.length >= 11) {
    national = digits.slice(2);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }
  return "+98" + national;
}

function isValidIranPhone(normalized: string): boolean {
  return /^\+989\d{9}$/.test(normalized);
}

function toPersianDigits(num: string): string {
  const digits: Record<string, string> = {
    "0": "۰", "1": "۱", "2": "۲", "3": "۳", "4": "۴",
    "5": "۵", "6": "۶", "7": "۷", "8": "۸", "9": "۹",
  };
  return num.replace(/\d/g, (ch) => digits[ch] || ch);
}

function mapAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("missing") && (m.includes("supabase") || m.includes("url") || m.includes("key"))) {
    return "پیکربندی Supabase یافت نشد. لطفاً بعداً تلاش کنید.";
  }
  if (m.includes("already registered") || m.includes("already exists") || (m.includes("user") && m.includes("registered"))) {
    return "این شماره موبایل قبلاً ثبت شده است. لطفاً وارد شوید.";
  }
  if (m.includes("expired")) {
    return "کد تأیید منقضی شده است. لطفاً دوباره درخواست دهید.";
  }
  if (m.includes("sms") || m.includes("phone provider") || (m.includes("send") && m.includes("sms"))) {
    return "ارسال پیامک تأیید با خطا مواجه شد. لطفاً دوباره تلاش کنید.";
  }
  if (m.includes("invalid") || m.includes("otp") || m.includes("token") || m.includes("code")) {
    return "کد تأیید نادرست است. لطفاً دوباره تلاش کنید.";
  }
  return message;
}

function isDevEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export default function SignupPage() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState(1);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [normalizedPhone, setNormalizedPhone] = useState("");
  const [isDev] = useState(isDevEnvironment);
  const [challengeToken, setChallengeToken] = useState("");
  const [devCode, setDevCode] = useState("");

  const handleInfoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("لطفاً نام والد را وارد کنید.");
      return;
    }
    if (name.trim().length < 2 || name.trim().length > 100) {
      setError("نام والد باید بین ۲ تا ۱۰۰ کاراکتر باشد.");
      return;
    }
    if (!phone.trim()) {
      setError("لطفاً شماره موبایل را وارد کنید.");
      return;
    }
    const normPhone = normalizeIranPhone(phone);
    if (!isValidIranPhone(normPhone)) {
      setError("شماره موبایل وارد شده معتبر نیست. لطفاً یک شماره موبایل ایران (مثلاً 09123456789) وارد کنید.");
      return;
    }
    if (!agreed) {
      setError("لطفاً تأیید کنید که اجازه استفاده از تصاویر و فایل‌های بارگذاری‌شده را دارید.");
      return;
    }

    setNormalizedPhone(normPhone);
    setLoading(true);

    if (isDev) {
      try {
        const res = await fetch("/api/dev/parent-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "signup_request_code",
            phone: phone,
            fullName: name.trim(),
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "درخواست کد تأیید انجام نشد.");
          return;
        }

        setChallengeToken(data.challengeToken);
        setDevCode(data.developmentCode);
        setCode("");
        setStep(2);
      } catch {
        setError("درخواست کد تأیید انجام نشد. لطفاً دوباره تلاش کنید.");
      } finally {
        setLoading(false);
      }
    } else {
      try {
        const supabase = createBrowserSupabaseClient();
        const { error: otpError } = await supabase.auth.signInWithOtp({
          phone: normPhone,
          options: {
            shouldCreateUser: true,
            data: { full_name: name.trim() },
          },
        });

        if (otpError) {
          setError(mapAuthError(otpError.message));
          return;
        }

        setCode("");
        setStep(2);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "خطای غیرمنتظره‌ای رخ داد.";
        setError(mapAuthError(message));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!/^\d{6}$/.test(code.trim())) {
      setError("لطفاً کد تأیید ۶ رقمی را وارد کنید.");
      return;
    }

    setLoading(true);

    if (isDev) {
      try {
        const res = await fetch("/api/dev/parent-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "signup_verify_code",
            phone: phone,
            fullName: name.trim(),
            code: code.trim(),
            challengeToken,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "کد تأیید نامعتبر است.");
          return;
        }

        window.location.assign("/parent-consent");
      } catch {
        setError("تأیید کد انجام نشد. لطفاً دوباره تلاش کنید.");
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const supabase = createBrowserSupabaseClient();
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        phone: normalizedPhone,
        token: code.trim(),
        type: "sms",
      });

      if (verifyError) {
        setError(mapAuthError(verifyError.message));
        return;
      }

      if (!data.session) {
        setError("جلسه کاربری ایجاد نشد. لطفاً دوباره تلاش کنید.");
        return;
      }

      window.location.assign("/parent-consent");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "خطای غیرمنتظره‌ای رخ داد.";
      setError(mapAuthError(message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <PendingCreationDraftCard stage="signup" />

      <Card>
        <h1 className="text-2xl font-brand text-parent-navy">ساخت حساب والدین</h1>
        <p className="mt-1 text-sm text-text-dark/60">
          برای شروع استفاده از کارتونا، نام و شماره موبایل والد یا سرپرست قانونی را وارد کنید.
        </p>

        <div className="mt-6 space-y-4">
          {step === 1 ? (
            <form onSubmit={handleInfoSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-dark">نام والد</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: مریم احمدی"
                  className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-dark">شماره موبایل</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="مثال: 09123456789"
                  className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                />
              </div>

              <div className="flex items-start gap-3">
                <input
                  id="permission-check"
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-soft-border text-candy-pink focus:ring-2 focus:ring-candy-pink/30"
                />
                <label htmlFor="permission-check" className="text-xs leading-relaxed text-text-dark/70 cursor-pointer select-none">
                  من تأیید می‌کنم که اجازه استفاده از تصاویر و فایل‌هایی را که در کارتونا بارگذاری می‌کنم دارم و مسئولیت استفاده از آن‌ها بر عهده من است.
                </label>
              </div>
              <p className="text-xs text-text-dark/40 -mt-2 mr-7">
                این تأییدیه مخصوص فایل‌ها و تصاویر خصوصی است که در مراحل ساخت درخواست کارتونی استفاده می‌شوند.
              </p>

              {error && <p className="text-xs text-coral">{error}</p>}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "در حال ارسال..." : isDev ? "دریافت کد آزمایشی" : "دریافت کد تأیید"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-4">
              {isDev && devCode && (
                <div className="rounded-xl border border-soft-border bg-cream/50 p-4 text-center">
                  <p className="text-xs text-text-dark/60">کد آزمایشی شما:</p>
                  <p className="mt-1 text-2xl font-bold tracking-widest text-parent-navy" dir="ltr">
                    {toPersianDigits(devCode)}
                  </p>
                  <p className="mt-1 text-xs text-text-dark/40">کد تا ۵ دقیقه معتبر است.</p>
                </div>
              )}

              {!isDev && (
                <p className="text-xs text-text-dark/40 text-center">
                  کد تأیید به شماره {phone} ارسال شد.
                </p>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-medium text-text-dark">کد تأیید</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="کد ۶ رقمی"
                  className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
                />
              </div>

              {error && <p className="text-xs text-coral">{error}</p>}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "در حال تأیید..." : "تأیید و ساخت حساب"}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full text-xs"
                onClick={() => {
                  setStep(1);
                  setError("");
                  setCode("");
                  setDevCode("");
                  setChallengeToken("");
                }}
              >
                اصلاح شماره موبایل
              </Button>
            </form>
          )}
        </div>
      </Card>

      <Card variant="playful">
        <h2 className="text-sm font-semibold text-parent-navy">حساب فقط برای والدین است</h2>
        <p className="mt-1 text-xs text-text-dark/60 leading-relaxed">
          در کارتونا کودک حساب مستقل، ورود جداگانه یا پروفایل عمومی ندارد.
          همه اطلاعات توسط والد یا سرپرست قانونی مدیریت می‌شود.
        </p>
      </Card>

      <p className="text-center text-sm text-text-dark/50">
        حساب دارید؟{" "}
        <a href="/login" className="text-candy-pink hover:opacity-80 transition-opacity">
          وارد شوید
        </a>
      </p>
    </div>
  );
}

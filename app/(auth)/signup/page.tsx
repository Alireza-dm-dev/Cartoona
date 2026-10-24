"use client";

import { useState, useSyncExternalStore } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/neu-button";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import PendingCreationDraftCard from "@/components/creation/pending-creation-draft-card";
import { ensureParentAccountSetup } from "@/lib/parent/account-setup/account-setup-client";
import AccountSetupRetry from "../account-setup-retry";
import {
  normalizeIranPhone,
  isValidIranPhone,
  toPersianDigits,
} from "@/lib/auth/phone";

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
  // An unconfigured SMS provider surfaces here. It is reported as a service
  // problem rather than as something the parent typed wrongly, because no
  // amount of retrying a correct phone number will fix it.
  if (
    m.includes("sms") ||
    m.includes("phone provider") ||
    m.includes("provider") ||
    m.includes("unsupported") ||
    (m.includes("send") && m.includes("sms"))
  ) {
    return "ارسال پیامک تأیید در حال حاضر ممکن نیست. لطفاً بعداً تلاش کنید یا با پشتیبانی تماس بگیرید.";
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

// The hostname never changes during the component's lifetime, so this store
// never needs to notify subscribers - it only exists to give
// useSyncExternalStore a server snapshot ("false") that matches SSR, so the
// dev-only label can't hydration-mismatch. The real value applies right
// after hydration, without a manual setState-in-effect.
function subscribeToNothing() {
  return () => {};
}

/**
 * Parent signup: a phone number, a code, and the upload permission checkbox.
 *
 * No name and no password are collected. A password is optional for the life
 * of the account and is set later from Settings; asking for one here would
 * make an optional credential a condition of having an account at all.
 */
export default function SignupPage() {
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState(1);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [normalizedPhone, setNormalizedPhone] = useState("");
  // getServerSnapshot ("false") matches SSR's `typeof window === "undefined"`
  // result, so the client's first render is identical to the server's; React
  // then swaps in the real getSnapshot value right after hydration.
  const isDev = useSyncExternalStore(subscribeToNothing, isDevEnvironment, () => false);
  const [challengeToken, setChallengeToken] = useState("");
  const [devCode, setDevCode] = useState("");
  // Signed up and signed in, but the account bootstrap did not complete (V0.1.49).
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  /**
   * After the code is verified the parent is signed in (Supabase). Before
   * /parent-consent (PostgreSQL) the account must exist there too: the
   * idempotent bootstrap creates it. A failure keeps the parent signed in on
   * a retry card - re-sending the (already used) code would not help.
   */
  const continueAfterSignup = async () => {
    const setup = await ensureParentAccountSetup();
    if (setup.status === "ready") {
      window.location.assign("/parent-consent");
      return;
    }
    if (setup.status === "retry") {
      setSetupMessage(setup.message);
      return;
    }
    setError(setup.message);
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

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
        // Phone OTP, not signUp({ phone, password }): the account is created
        // by verifying the code, so no password has to exist for a parent to
        // have an account. shouldCreateUser is left at its default (true),
        // which is what makes this the signup path rather than a login.
        const { error: otpError } = await supabase.auth.signInWithOtp({
          phone: normPhone,
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
            code: code.trim(),
            challengeToken,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "کد تأیید نامعتبر است.");
          return;
        }

        await continueAfterSignup();
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

      // The parent profile is created server-side against the new session.
      // Without this the account would reach the dashboard with no profile row,
      // so a failure here keeps the parent on this step rather than continuing.
      const completion = await fetch("/api/parent/complete-signup", { method: "POST" });
      if (!completion.ok) {
        const body = await completion.json().catch(() => ({}));
        setError(body.error || "تکمیل ثبت‌نام انجام نشد. لطفاً دوباره تلاش کنید.");
        return;
      }

      await continueAfterSignup();
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
          برای شروع استفاده از کارتونا، فقط شماره موبایل والد یا سرپرست قانونی را وارد کنید.
        </p>

        {setupMessage !== null ? (
          <AccountSetupRetry message={setupMessage} onReady={() => window.location.assign("/parent-consent")} />
        ) : (
        <div className="mt-6 space-y-4">
          {step === 1 ? (
            <form onSubmit={handlePhoneSubmit} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="signup-phone" className="block text-sm font-medium text-text-dark">
                  شماره موبایل
                </label>
                <input
                  id="signup-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="مثال: 09123456789"
                  className="neu-recessed w-full min-h-[44px] rounded-xl px-3 py-2 text-sm outline-none transition-shadow"
                />
                <p className="text-xs text-text-dark/40">
                  کد ورود به همین شماره ارسال می‌شود. تنظیم رمز عبور اختیاری است و بعداً از بخش تنظیمات انجام می‌شود.
                </p>
              </div>

              <div className="flex items-start gap-3">
                <input
                  id="permission-check"
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-soft-border text-candy-pink accent-[var(--candy-pink)] focus:ring-2 focus:ring-candy-pink/30"
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
                <div className="neu-pressed p-4 text-center">
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
                <label htmlFor="signup-code" className="block text-sm font-medium text-text-dark">
                  کد تأیید
                </label>
                <input
                  id="signup-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="کد ۶ رقمی"
                  className="neu-recessed w-full min-h-[44px] rounded-xl px-3 py-2 text-sm text-center text-lg tracking-widest outline-none transition-shadow"
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
        )}
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

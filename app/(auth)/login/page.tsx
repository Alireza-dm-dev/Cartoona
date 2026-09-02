"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const ENGLISH_DIGITS = "0123456789";

function toEnglishDigits(raw: string): string {
  let result = "";
  for (const ch of raw) {
    const pi = PERSIAN_DIGITS.indexOf(ch);
    if (pi !== -1) { result += ENGLISH_DIGITS[pi]; continue; }
    const ai = ARABIC_DIGITS.indexOf(ch);
    if (ai !== -1) { result += ENGLISH_DIGITS[ai]; continue; }
    result += ch;
  }
  return result;
}

function normalizeIranPhone(raw: string): string {
  const cleaned = toEnglishDigits(raw).replace(/[\s\-()]/g, "");
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

function mapLoginError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("missing") && (m.includes("supabase") || m.includes("url") || m.includes("key"))) {
    return "پیکربندی Supabase یافت نشد. لطفاً بعداً تلاش کنید.";
  }
  if (m.includes("not confirmed") || m.includes("unverified") || m.includes("phone")) {
    return "شماره موبایل هنوز تأیید نشده است. لطفاً ابتدا ثبت‌نام کنید.";
  }
  if (m.includes("rate") || m.includes("too many") || m.includes("attempt")) {
    return "تلاش‌های ورود بیش از حد مجاز بود. لطفاً کمی بعد دوباره تلاش کنید.";
  }
  if (m.includes("invalid") || m.includes("credential") || m.includes("password")) {
    return "شماره موبایل یا رمز عبور نادرست است.";
  }
  return "ورود انجام نشد. لطفاً دوباره تلاش کنید.";
}

function isDevEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const ALLOWED_PARENT_PATHS = new Set([
  "/dashboard",
  "/parent-consent",
  "/complete-request",
]);

function getSafeParentDestination(value: string | null): string | null {
  if (!value) return null;
  if (value.length > 200) return null;
  if (value.includes("\\")) return null;
  if (value.includes("..")) return null;
  if (value.includes("%00")) return null;
  if (value.includes("\0")) return null;
  if (value.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (!value.startsWith("/")) return null;

  const path = value.split("?")[0].split("#")[0];

  if (ALLOWED_PARENT_PATHS.has(path)) return path;
  if (path.startsWith("/dashboard/")) return path;

  return null;
}

function resolveSuccessfulLoginDestination(
  safeFrom: string | null,
  consentGranted: boolean
): string {
  if (safeFrom) {
    if (safeFrom === "/parent-consent") return safeFrom;
    if (!consentGranted && (safeFrom === "/dashboard" || safeFrom.startsWith("/dashboard/"))) {
      return "/parent-consent";
    }
    return safeFrom;
  }
  return consentGranted ? "/dashboard" : "/parent-consent";
}
type LoginMode = "sms" | "password";

export default function LoginPage() {
  const [mode, setMode] = useState<LoginMode>("sms");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isDev] = useState(isDevEnvironment);
  const [smsStep, setSmsStep] = useState(1);
  const [code, setCode] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [devCode, setDevCode] = useState("");
  const [expiredNotice] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("reason");
  });

  const handleSmsRequestCode = async (e: React.FormEvent) => {
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

    setLoading(true);

    if (isDev) {
      try {
        const res = await fetch("/api/dev/parent-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "login_request_code",
            phone: phone,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "درخواست کد ورود انجام نشد.");
          return;
        }

        setChallengeToken(data.challengeToken);
        setDevCode(data.developmentCode);
        setCode("");
        setSmsStep(2);
      } catch {
        setError("درخواست کد ورود انجام نشد. لطفاً دوباره تلاش کنید.");
      } finally {
        setLoading(false);
      }
    } else {
      try {
        const supabase = createBrowserSupabaseClient();
        const { error: otpError } = await supabase.auth.signInWithOtp({
          phone: normPhone,
          options: {
            shouldCreateUser: false,
          },
        });

        if (otpError) {
          setError(mapLoginError(otpError.message));
          return;
        }

        setCode("");
        setSmsStep(2);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        setError(mapLoginError(message));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleSmsVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!/^\d{6}$/.test(code.trim())) {
      setError("لطفاً کد ۶ رقمی را وارد کنید.");
      return;
    }

    setLoading(true);

    if (isDev) {
      try {
        const res = await fetch("/api/dev/parent-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "login_verify_code",
            phone: phone,
            code: code.trim(),
            challengeToken,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "شماره موبایل یا کد ورود صحیح نیست.");
          return;
        }

        const devFrom = getSafeParentDestination(data.next);
        const destination = resolveSuccessfulLoginDestination(devFrom, true);
        window.location.assign(destination);
      } catch {
        setError("ورود انجام نشد. لطفاً دوباره تلاش کنید.");
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const supabase = createBrowserSupabaseClient();
      const normPhone = normalizeIranPhone(phone);

      const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
        phone: normPhone,
        token: code.trim(),
        type: "sms",
      });

      if (verifyError) {
        setError(mapLoginError(verifyError.message));
        return;
      }

      if (!verifyData.session?.user) {
        setError("ورود انجام نشد. لطفاً دوباره تلاش کنید.");
        return;
      }

      const { data: profileRow } = await supabase
        .from("parent_profiles")
        .select("consent_granted")
        .eq("user_id", verifyData.session.user.id)
        .maybeSingle();

      const safeFrom = getSafeParentDestination(
        new URLSearchParams(window.location.search).get("from")
      );
      const consentGranted = profileRow?.consent_granted ?? false;
      const destination = resolveSuccessfulLoginDestination(safeFrom, consentGranted);

      window.location.assign(destination);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(mapLoginError(message));
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
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
    if (!password) {
      setError("لطفاً رمز عبور را وارد کنید.");
      return;
    }

    setLoading(true);

    if (isDev) {
      try {
        const res = await fetch("/api/dev/parent-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "password_login",
            phone: phone,
            password,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "شماره موبایل یا رمز عبور صحیح نیست.");
          return;
        }

        const devFrom = getSafeParentDestination(data.next);
        const destination = resolveSuccessfulLoginDestination(devFrom, true);
        window.location.assign(destination);
      } catch {
        setError("ورود انجام نشد. لطفاً دوباره تلاش کنید.");
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const supabase = createBrowserSupabaseClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        phone: normPhone,
        password,
      });

      if (signInError) {
        setError(mapLoginError(signInError.message));
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      const safeFrom = getSafeParentDestination(
        new URLSearchParams(window.location.search).get("from")
      );
      let destination: string;

      if (user) {
        const { data: profileRow } = await supabase
          .from("parent_profiles")
          .select("consent_granted")
          .eq("user_id", user.id)
          .maybeSingle();
        const consentGranted = profileRow?.consent_granted ?? false;
        destination = resolveSuccessfulLoginDestination(safeFrom, consentGranted);
      } else {
        destination = "/dashboard";
      }

      window.location.assign(destination);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(mapLoginError(message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <h1 className="text-2xl font-brand text-parent-navy">ورود والدین</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        برای ورود به پنل والدین، شماره موبایل خود را وارد کنید.
      </p>

      {expiredNotice === "session_expired" && (
        <div className="mt-4 rounded-xl border border-soft-border bg-cream/50 p-4 text-center">
          <p className="text-sm text-text-dark">
            برای حفظ امنیت حساب، پس از ۳۰ روز باید دوباره وارد شوید.
          </p>
        </div>
      )}

      <div className="mt-6 flex gap-2 border-b border-soft-border pb-0">
        <button
          type="button"
          className={`pb-2 px-4 text-sm font-medium transition-colors border-b-2 ${
            mode === "sms"
              ? "border-candy-pink text-candy-pink"
              : "border-transparent text-text-dark/50 hover:text-text-dark/70"
          }`}
          onClick={() => { setMode("sms"); setError(""); setSmsStep(1); setCode(""); }}
        >
          ورود با کد پیامکی
        </button>
        <button
          type="button"
          className={`pb-2 px-4 text-sm font-medium transition-colors border-b-2 ${
            mode === "password"
              ? "border-candy-pink text-candy-pink"
              : "border-transparent text-text-dark/50 hover:text-text-dark/70"
          }`}
          onClick={() => { setMode("password"); setError(""); }}
        >
          ورود با رمز عبور
        </button>
      </div>

      {mode === "sms" && smsStep === 1 && (
        <form onSubmit={handleSmsRequestCode} className="mt-6 space-y-4">
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

          {error && <p className="text-xs text-coral">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "در حال ارسال..." : "دریافت کد ورود"}
          </Button>
        </form>
      )}

      {mode === "sms" && smsStep === 2 && (
        <form onSubmit={handleSmsVerifyCode} className="mt-6 space-y-4">
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
              کد ورود به شماره {phone} ارسال شد.
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
            {loading ? "در حال ورود..." : "ورود"}
          </Button>

          <Button
            type="button"
            variant="ghost"
            className="w-full text-xs"
            onClick={() => {
              setSmsStep(1);
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

      {mode === "password" && (
        <form onSubmit={handlePasswordSubmit} className="mt-6 space-y-4">
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

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-dark">رمز عبور</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="رمز عبور"
              className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
            />
          </div>

          {error && <p className="text-xs text-coral">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "در حال ورود..." : "ورود"}
          </Button>
        </form>
      )}

      <p className="mt-4 text-center text-sm text-text-dark/50">
        حساب ندارید؟{" "}
        <a href="/signup" className="text-candy-pink hover:opacity-80 transition-opacity">
          ساخت حساب
        </a>
      </p>
    </Card>
  );
}

"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  normalizeIranPhone,
  isValidIranPhone,
  toPersianDigits,
} from "@/lib/auth/phone";
import {
  getSafeParentDestination,
  resolveSuccessfulLoginDestination,
} from "@/lib/auth/parent-destinations";

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

/**
 * The dev route answers with `next`, which encodes only whether consent has
 * been granted. Combining that with `?from=` keeps the redirect the parent
 * actually asked for while still diverting un-consented parents to consent.
 */
function resolveDevDestination(next: unknown): string {
  const consentGranted = next === "/dashboard";
  const safeFrom = getSafeParentDestination(
    new URLSearchParams(window.location.search).get("from")
  );
  return resolveSuccessfulLoginDestination(safeFrom, consentGranted);
}

type LoginMode = "sms" | "password";

export default function LoginPage() {
  const [mode, setMode] = useState<LoginMode>("password");
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

        window.location.assign(resolveDevDestination(data.next));
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

        window.location.assign(resolveDevDestination(data.next));
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
        برای ورود به پنل والدین، شماره موبایل و رمز عبور خود را وارد کنید.
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
            mode === "password"
              ? "border-candy-pink text-candy-pink"
              : "border-transparent text-text-dark/50 hover:text-text-dark/70"
          }`}
          onClick={() => { setMode("password"); setError(""); }}
        >
          ورود با رمز عبور
        </button>
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

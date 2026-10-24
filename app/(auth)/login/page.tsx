"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/neu-button";
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
import { PARENT_PORTAL_HOME } from "@/lib/parent/navigation/parent-nav";
import { readParentConsent } from "@/lib/parent/consent/consent-client";
import { ensureParentAccountSetup } from "@/lib/parent/account-setup/account-setup-client";
import AccountSetupRetry from "../account-setup-retry";

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
    return PASSWORD_LOGIN_FAILED_MESSAGE;
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

/**
 * Consent for the post-login redirect, from PostgreSQL via the Next BFF
 * (V0.1.48; it was a browser read of Supabase's parent_profiles). The session
 * cookies were just written by the sign-in call, so the BFF sees the new
 * session. "Could not determine" (null) is routed like "not granted": to
 * /parent-consent, which reads consent itself and forwards a parent who has
 * already consented - so an outage never strands anyone and never loops.
 */
async function readConsentForLogin(): Promise<boolean> {
  return (await readParentConsent()) === true;
}

type LoginMode = "sms" | "password";

/**
 * One answer for every password-login failure.
 *
 * A parent who never set a password cannot be told so directly without that
 * same answer revealing, for any phone number, whether an account exists. The
 * message therefore stays neutral and points at the code route instead, which
 * is the thing that will actually work for them.
 */
const PASSWORD_LOGIN_FAILED_MESSAGE =
  "شماره موبایل یا رمز عبور صحیح نیست. اگر برای این حساب رمز عبور تنظیم نکرده‌اید، با «ورود با کد» وارد شوید.";

export default function LoginPage() {
  // Code login is the default: every parent can use it, while password login
  // only works for the subset who chose to set one.
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
  // Signed in, but the account bootstrap did not complete (V0.1.49): the
  // retry card replaces the forms, and `destination` runs once it is ready.
  const [setupPending, setSetupPending] = useState<null | { message: string; destination: () => Promise<string> }>(null);
  const [expiredNotice] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("reason");
  });

  /**
   * Every successful sign-in ends here (V0.1.49): first make sure the
   * account exists in Cartoona's PostgreSQL (idempotent, a no-op for an
   * existing account), only then pick the destination - which may read
   * consent, and which every parent page after it needs the account for.
   * A failure keeps the parent signed in and shows a retry, never a
   * half-ready dashboard.
   */
  const continueAfterSignIn = async (destination: () => Promise<string>) => {
    const setup = await ensureParentAccountSetup();
    if (setup.status === "ready") {
      window.location.assign(await destination());
      return;
    }
    if (setup.status === "retry") {
      setSetupPending({ message: setup.message, destination });
      return;
    }
    setError(setup.message);
  };

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

        await continueAfterSignIn(async () => resolveDevDestination(data.next));
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

      const safeFrom = getSafeParentDestination(
        new URLSearchParams(window.location.search).get("from")
      );
      await continueAfterSignIn(async () => resolveSuccessfulLoginDestination(safeFrom, await readConsentForLogin()));
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
          setError(data.error || PASSWORD_LOGIN_FAILED_MESSAGE);
          return;
        }

        await continueAfterSignIn(async () => resolveDevDestination(data.next));
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
      if (user) {
        await continueAfterSignIn(async () => resolveSuccessfulLoginDestination(safeFrom, await readConsentForLogin()));
      } else {
        window.location.assign(PARENT_PORTAL_HOME);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(mapLoginError(message));
    } finally {
      setLoading(false);
    }
  };

  if (setupPending) {
    return (
      <Card>
        <h1 className="text-2xl font-brand text-parent-navy">ورود والدین</h1>
        <AccountSetupRetry
          message={setupPending.message}
          onReady={async () => window.location.assign(await setupPending.destination())}
        />
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-2xl font-brand text-parent-navy">ورود والدین</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        برای ورود به پنل والدین، شماره موبایل خود را وارد کنید و کد ورود را دریافت کنید.
        اگر رمز عبور تنظیم کرده‌اید، می‌توانید با رمز عبور هم وارد شوید.
      </p>

      {expiredNotice === "session_expired" && (
        <div className="mt-4 neu-recessed rounded-xl p-4 text-center">
          <p className="text-sm text-text-dark">
            برای حفظ امنیت حساب، پس از ۳۰ روز باید دوباره وارد شوید.
          </p>
        </div>
      )}

      {/* Code login comes first in the order as well as in the default: it is
          the method that works for every parent. */}
      <div className="mt-6 flex gap-1.5 rounded-2xl p-1.5 neu-raised">
        <button
          type="button"
          aria-pressed={mode === "sms"}
          className={`flex-1 min-h-[44px] rounded-xl px-4 text-sm font-medium transition-all ${
            mode === "sms"
              ? "neu-pressed-pink font-semibold"
              : "neu-interactive text-text-dark/60 hover:text-text-dark"
          }`}
          onClick={() => { setMode("sms"); setError(""); setSmsStep(1); setCode(""); }}
        >
          ورود با کد
        </button>
        <button
          type="button"
          aria-pressed={mode === "password"}
          className={`flex-1 min-h-[44px] rounded-xl px-4 text-sm font-medium transition-all ${
            mode === "password"
              ? "neu-pressed-pink font-semibold"
              : "neu-interactive text-text-dark/60 hover:text-text-dark"
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
              className="neu-recessed w-full min-h-[44px] rounded-xl px-3 py-2 text-sm outline-none transition-shadow"
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
              className="neu-recessed w-full min-h-[44px] rounded-xl px-3 py-2 text-sm text-center text-lg tracking-widest outline-none transition-shadow"
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
              className="neu-recessed w-full min-h-[44px] rounded-xl px-3 py-2 text-sm outline-none transition-shadow"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="login-password" className="block text-sm font-medium text-text-dark">رمز عبور</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="رمز عبور"
              className="neu-recessed w-full min-h-[44px] rounded-xl px-3 py-2 text-sm outline-none transition-shadow"
            />
            <p className="text-xs text-text-dark/40">
              رمز عبور اختیاری است. اگر برای حساب خود رمز عبور تنظیم نکرده‌اید، از «ورود با کد» استفاده کنید.
            </p>
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

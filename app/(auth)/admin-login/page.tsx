"use client"

import { useState } from "react"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { createBrowserSupabaseClient } from "@/lib/supabase/client"

function mapLoginError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes("invalid") || m.includes("credential") || m.includes("password")) {
    return "ایمیل یا رمز عبور صحیح نیست."
  }
  if (m.includes("rate") || m.includes("too many") || m.includes("attempt")) {
    return "تلاش‌های ورود بیش از حد مجاز بود. لطفاً کمی بعد دوباره تلاش کنید."
  }
  return "ورود انجام نشد. لطفاً دوباره تلاش کنید."
}

function isValidAdminDestination(from: string | null): string | null {
  if (!from) return null
  if (!from.startsWith("/")) return null
  if (from.startsWith("//")) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(from)) return null
  if (!from.startsWith("/admin")) return null
  if (from === "/admin") return from
  if (from.startsWith("/admin/")) return from
  return null
}

export default function AdminLoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!email.trim()) {
      setError("لطفاً ایمیل را وارد کنید.")
      return
    }
    if (!password) {
      setError("لطفاً رمز عبور را وارد کنید.")
      return
    }

    setLoading(true)
    try {
      const supabase = createBrowserSupabaseClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (signInError) {
        setError(mapLoginError(signInError.message))
        return
      }

      const params = new URLSearchParams(window.location.search)
      const rawFrom = params.get("from")
      const destination = isValidAdminDestination(rawFrom) || "/admin"

      window.location.assign(destination)
    } catch {
      setError("ورود انجام نشد. لطفاً دوباره تلاش کنید.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <h1 className="text-2xl font-brand text-parent-navy">ورود مدیر</h1>
      <p className="mt-1 text-sm text-text-dark/60">
        برای ورود به پنل مدیریت، ایمیل و رمز عبور حساب مدیریتی خود را وارد کنید.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium text-text-dark">
            ایمیل
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            required
            className="w-full rounded-lg border border-soft-border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-candy-pink/30"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium text-text-dark">
            رمز عبور
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="رمز عبور"
            required
            className="w-full rounded-lg border border-soft-border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-candy-pink/30"
          />
        </div>

        {error && (
          <p className="text-xs text-coral" role="alert">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "در حال ورود…" : "ورود به پنل مدیریت"}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm">
        <Link href="/" className="text-candy-pink hover:opacity-80 transition-opacity">
          بازگشت به سایت
        </Link>
      </p>
    </Card>
  )
}

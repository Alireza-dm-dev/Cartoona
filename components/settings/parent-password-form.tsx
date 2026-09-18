"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"

/**
 * Set or change the optional parent password.
 *
 * `passwordSet` only changes the wording — whether the parent is adding a
 * first password or replacing one they already have. It is never a gate: a
 * parent can always submit this form, and the server is what actually decides
 * the outcome.
 */
export function ParentPasswordForm({ passwordSet = false }: { passwordSet?: boolean }) {
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")

    if (password.length < 8) {
      setError("رمز عبور باید حداقل ۸ کاراکتر باشد.")
      return
    }
    if (password.length > 72) {
      setError("رمز عبور نباید بیشتر از ۷۲ کاراکتر باشد.")
      return
    }
    if (password !== confirmPassword) {
      setError("رمز عبور و تکرار آن یکسان نیستند.")
      return
    }

    setLoading(true)

    try {
      const res = await fetch("/api/parent/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirmPassword }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "تنظیم رمز عبور انجام نشد. لطفاً دوباره تلاش کنید.")
        return
      }

      setSuccess(
        passwordSet
          ? "رمز عبور با موفقیت تغییر کرد."
          : "رمز عبور با موفقیت تنظیم شد.",
      )
      setPassword("")
      setConfirmPassword("")
    } catch {
      setError("تنظیم رمز عبور انجام نشد. لطفاً دوباره تلاش کنید.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="parent-new-password" className="block text-sm font-medium text-text-dark">
          {passwordSet ? "رمز عبور جدید" : "رمز عبور"}
        </label>
        <input
          id="parent-new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="حداقل ۸ کاراکتر"
          required
          minLength={8}
          maxLength={72}
          className="w-full min-h-[44px] rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="parent-confirm-password" className="block text-sm font-medium text-text-dark">
          {passwordSet ? "تکرار رمز عبور جدید" : "تکرار رمز عبور"}
        </label>
        <input
          id="parent-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="تکرار رمز عبور"
          required
          minLength={8}
          maxLength={72}
          className="w-full min-h-[44px] rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
        />
      </div>

      {error && <p className="text-xs text-coral" role="alert">{error}</p>}

      {success && (
        <p className="text-xs text-green-600" role="status">{success}</p>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading
          ? "در حال ذخیره…"
          : passwordSet
            ? "تغییر رمز عبور"
            : "تنظیم رمز عبور"}
      </Button>
    </form>
  )
}

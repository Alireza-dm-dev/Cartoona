"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"

export function ParentPasswordForm() {
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

      setSuccess("رمز عبور با موفقیت تنظیم شد.")
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
        <label className="block text-sm font-medium text-text-dark">رمز عبور جدید</label>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="حداقل ۸ کاراکتر"
          required
          minLength={8}
          maxLength={72}
          className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-text-dark">تکرار رمز عبور جدید</label>
        <input
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="تکرار رمز عبور"
          required
          minLength={8}
          maxLength={72}
          className="w-full rounded-lg border border-soft-border bg-soft-border/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-candy-pink/30"
        />
      </div>

      {error && <p className="text-xs text-coral" role="alert">{error}</p>}

      {success && (
        <p className="text-xs text-green-600" role="status">{success}</p>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "در حال ذخیره…" : "ذخیره رمز عبور"}
      </Button>
    </form>
  )
}

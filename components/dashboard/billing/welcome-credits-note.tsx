import { Card } from "@/components/ui/card"

/**
 * Remaining one-time welcome IMAGE credits.
 *
 * Deliberately a separate element from the candy balance: these are not candy,
 * and the copy says they apply to image creation only, so a parent does not
 * read them as spendable on video or drawing animation. Hidden at zero - there
 * is nothing to promote - rather than shown as an empty balance.
 */
export function WelcomeCreditsNote({ remaining }: { remaining: number | undefined }) {
  if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining <= 0) return null

  return (
    <Card className="border-soft-purple/20 bg-soft-purple/5 py-4 text-center" data-testid="welcome-credits-note">
      <p className="text-sm font-semibold text-parent-navy">
        اعتبار رایگان ساخت تصویر: {remaining.toLocaleString("fa-IR")}
      </p>
      <p className="mt-1 text-xs text-text-dark/50">
        فقط برای ساخت تصویر استفاده می‌شود و پیش از آبنبات کسر می‌شود.
      </p>
    </Card>
  )
}

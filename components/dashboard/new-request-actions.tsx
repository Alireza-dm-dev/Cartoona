import Link from "next/link";
import { Card } from "@/components/ui/card";
import { CREATION_CHOICES } from "@/lib/creation/creation-routes";

/**
 * Compact "new request" action area for the parent portal.
 *
 * This replaces the old dashboard "شروع سریع" block. It is deliberately a thin
 * row of links rather than a second creation surface: each choice leaves the
 * portal for the public creation route that owns that form. The request list
 * stays the primary content of the page, so this stays visually quiet.
 */
export function NewRequestActions() {
  return (
    <Card variant="admin" className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-parent-navy">سفارش جدید</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {CREATION_CHOICES.map((choice) => (
          <Link
            key={choice.type}
            href={choice.href}
            className="flex min-h-[44px] items-center gap-2 rounded-lg border border-soft-border bg-white px-3 text-sm font-medium text-text-dark transition-colors hover:border-candy-pink/40 hover:text-candy-pink"
          >
            <span aria-hidden="true">{choice.icon}</span>
            <span>{choice.label}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

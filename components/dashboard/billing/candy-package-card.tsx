"use client"

import type { CandyPackageSummary } from "@/lib/candy-purchases/types"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

interface CandyPackageCardProps {
  pkg: CandyPackageSummary
  onSelect: (pkg: CandyPackageSummary) => void
  disabled: boolean
}

export function CandyPackageCard({ pkg, onSelect, disabled }: CandyPackageCardProps) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-brand text-lg font-bold text-text-dark">
            {pkg.name}
          </h3>
          {pkg.description && (
            <p className="mt-1 text-sm text-text-dark/60">{pkg.description}</p>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-brand text-3xl font-bold text-candy-pink">
          {pkg.candyAmount.toLocaleString("fa-IR")}
        </span>
        <span className="text-sm text-text-dark/60">آبنبات</span>
      </div>

      <div className="mt-1 flex items-baseline gap-1">
        <Badge variant="default" size="sm">
          {pkg.priceAmount.toLocaleString("fa-IR")} {pkg.currency === "IRR" ? "ریال" : pkg.currency}
        </Badge>
      </div>

      <div className="mt-auto pt-5">
        <Button
          variant="primary"
          size="md"
          className="w-full"
          onClick={() => onSelect(pkg)}
          disabled={disabled}
        >
          انتخاب بسته
        </Button>
      </div>
    </Card>
  )
}

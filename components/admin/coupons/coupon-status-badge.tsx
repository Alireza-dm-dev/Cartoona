import { Badge } from "@/components/ui/badge"
import {
  statusLabels,
  statusVariants,
} from "@/lib/admin/coupons/format"
import type { AdminCouponStatus } from "@/lib/admin/coupons/types"

interface CouponStatusBadgeProps {
  status: AdminCouponStatus
  size?: "sm" | "md"
}

export function CouponStatusBadge({ status, size = "sm" }: CouponStatusBadgeProps) {
  return (
    <Badge variant={statusVariants[status]} size={size}>
      {statusLabels[status]}
    </Badge>
  )
}

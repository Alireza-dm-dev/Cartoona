import type { OrderStatus } from "@/types/app";
import { Badge } from "./badge";

const statusConfig: Record<OrderStatus, { label: string; variant: "default" | "success" | "warning" | "danger" | "info" }> = {
  draft: { label: "پیش‌نویس", variant: "default" },
  pending_payment: { label: "در انتظار پرداخت", variant: "warning" },
  pending_review: { label: "در انتظار بررسی", variant: "info" },
  in_progress: { label: "در حال انجام", variant: "info" },
  ready: { label: "آماده تحویل", variant: "success" },
  delivered: { label: "تحویل داده شده", variant: "success" },
  rejected: { label: "رد شده", variant: "danger" },
  cancelled: { label: "لغو شده", variant: "danger" },
};

interface OrderStatusBadgeProps {
  status: OrderStatus;
}

export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.draft;
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

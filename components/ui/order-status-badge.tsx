import type { OrderStatus } from "@/types/app";
import { Badge } from "./badge";

const statusConfig: Record<OrderStatus, { label: string; variant: "default" | "success" | "warning" | "danger" | "info" }> = {
  draft: { label: "Draft", variant: "default" },
  pending_payment: { label: "Pending Payment", variant: "warning" },
  pending_review: { label: "Pending Review", variant: "info" },
  in_progress: { label: "In Progress", variant: "info" },
  ready: { label: "Ready", variant: "success" },
  delivered: { label: "Delivered", variant: "success" },
  rejected: { label: "Rejected", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "danger" },
};

interface OrderStatusBadgeProps {
  status: OrderStatus;
}

export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.draft;
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

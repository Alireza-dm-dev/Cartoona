export type UserRole = "guest" | "parent" | "admin" | "super_admin";

export type OrderType = "image" | "video" | "drawing_animation";

export type OrderStatus =
  | "draft"
  | "pending_payment"
  | "pending_review"
  | "in_progress"
  | "ready"
  | "delivered"
  | "rejected"
  | "cancelled";

export type ModerationStatus =
  | "pending"
  | "passed"
  | "flagged"
  | "blocked"
  | "manual_review";

import type { OrderStatus, OrderType, ModerationStatus, UserRole } from "./app";

export interface DbUser {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DbParentProfile {
  id: string;
  user_id: string;
  full_name: string;
  consent_granted: boolean;
  consent_granted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbChildProfile {
  id: string;
  parent_id: string;
  name: string;
  birth_year: number | null;
  favorite_character_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbCharacter {
  id: string;
  name: string;
  description: string;
  category: string;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbOrder {
  id: string;
  parent_id: string;
  type: OrderType;
  status: OrderStatus;
  title: string;
  description: string | null;
  character_id: string | null;
  candy_cost: number;
  moderation_status: ModerationStatus;
  assigned_admin_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMediaAsset {
  id: string;
  order_id: string;
  type: "upload" | "generated";
  file_url: string;
  mime_type: string;
  moderation_status: ModerationStatus;
  created_at: string;
}

export interface DbCandyWallet {
  id: string;
  parent_id: string;
  balance: number;
  created_at: string;
  updated_at: string;
}

export interface DbCandyTransaction {
  id: string;
  wallet_id: string;
  amount: number;
  type: "purchase" | "spend" | "refund" | "grant";
  reference_type: string | null;
  reference_id: string | null;
  description: string | null;
  created_at: string;
}

export interface DbVideoRequest {
  id: string;
  order_id: string;
  script: string | null;
  duration_seconds: number | null;
  style: string | null;
  output_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbDrawingAnimationRequest {
  id: string;
  order_id: string;
  upload_url: string;
  animation_style: string | null;
  output_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbModerationLog {
  id: string;
  target_type: string;
  target_id: string;
  action: string;
  moderator_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface DbAuditLog {
  id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

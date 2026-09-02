import type { OrderStatus, OrderType } from "@/types/app";

export type AdminRequestQueueSort = "created_at_desc";

export interface AdminRequestQueueFilters {
  type: OrderType | null;
  status: OrderStatus | null;
}

export interface AdminRequestPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminQueueRow {
  id: string;
  type: OrderType | null;
  typeLabel: string;
  status: OrderStatus | null;
  statusLabel: string;
  title: string;
  parentName: string | null;
  parentDeleted: boolean;
  childLabel: string;
  candyCost: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminQueueResult {
  rows: AdminQueueRow[];
  pagination: AdminRequestPagination;
  hasFilters: boolean;
}

export interface AdminParentInfo {
  name: string | null;
  email: string | null;
  deleted: boolean;
}

export interface AdminMediaAssetInfo {
  id: string;
  kind: "upload" | "generated";
  mimeType: string | null;
  fileName: string | null;
  uploadedAt: string;
  signedUrl: string | null;
  signedUrlFailed: boolean;
}

export interface AdminTypeDetailRow {
  label: string;
  value: string;
  multiline?: boolean;
}

export interface AdminOrderDetail {
  id: string;
  type: OrderType | null;
  typeLabel: string;
  status: OrderStatus | null;
  statusLabel: string;
  title: string;
  description: string | null;
  candyCost: number;
  moderationStatus: string;
  moderationStatusLabel: string;
  createdAt: string;
  updatedAt: string;
  parent: AdminParentInfo;
  childLabel: string;
  characterName: string | null;
  typeRows: AdminTypeDetailRow[];
  consentGranted: boolean;
  media: AdminMediaAssetInfo[];
}

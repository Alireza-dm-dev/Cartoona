import type { OrderStatus, OrderType } from "@/types/app";
import { adminRequestTypeLabels, UNKNOWN_REQUEST_TYPE_LABEL } from "@/config/admin";
import {
  ALL_ORDER_STATUSES,
  isKnownOrderStatus,
  mapOrderStatusLabel,
} from "@/lib/admin/requests/workflow";
import type {
  AdminMediaAssetInfo,
  AdminOrderDetail,
  AdminParentInfo,
  AdminQueueRow,
  AdminTypeDetailRow,
} from "@/lib/admin/requests/types";

// Re-exported so existing consumers (pages, validation, tests) keep working.
// The status strings and Persian labels live ONLY in lib/admin/requests/workflow.ts.
export { isKnownOrderStatus, mapOrderStatusLabel };

/** Alias of workflow.ALL_ORDER_STATUSES for backwards compatibility. */
export const KNOWN_ORDER_STATUSES: readonly OrderStatus[] = ALL_ORDER_STATUSES;

export const KNOWN_ORDER_TYPES: readonly OrderType[] = ["image", "video", "drawing_animation"];

const MODERATION_LABELS: Record<string, string> = {
  pending: "در انتظار بررسی",
  passed: "تأیید شده",
  flagged: "علامت‌گذاری شده",
  blocked: "مسدود شده",
  manual_review: "نیازمند بررسی دستی",
};

const UNKNOWN_MODERATION_LABEL = "نامشخص";

const CHILD_PROFILE_MISSING_LABEL = "بدون پروفایل کودک";
const PARENT_DELETED_LABEL = "حساب والد حذف شده است";

export function isKnownOrderType(value: string | null | undefined): value is OrderType {
  return typeof value === "string" && (KNOWN_ORDER_TYPES as readonly string[]).includes(value);
}

export function mapRequestTypeLabel(type: string | null | undefined): string {
  if (isKnownOrderType(type)) return adminRequestTypeLabels[type];
  return UNKNOWN_REQUEST_TYPE_LABEL;
}

export function mapModerationStatusLabel(status: string | null | undefined): string {
  if (typeof status === "string" && status in MODERATION_LABELS) return MODERATION_LABELS[status];
  return UNKNOWN_MODERATION_LABEL;
}

export function mapChildProfileLabel(childProfileId: string | null | undefined): string {
  return childProfileId ? childProfileId : CHILD_PROFILE_MISSING_LABEL;
}

export function mapParentInfo(
  fullName: string | null | undefined,
  email: string | null | undefined,
  profileMissing: boolean,
): AdminParentInfo {
  if (profileMissing) {
    return { name: null, email: null, deleted: true };
  }
  return {
    name: fullName || null,
    email: email || null,
    deleted: false,
  };
}

function safeFileName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  return last;
}

export function mapMediaAsset(
  asset: {
    id: string;
    type: string | null;
    mime_type: string | null;
    file_url: string | null;
    created_at: string;
  },
  signedUrl: string | null,
): AdminMediaAssetInfo {
  const kind = asset.type === "generated" ? "generated" : "upload";
  return {
    id: asset.id,
    kind,
    mimeType: asset.mime_type || null,
    fileName: safeFileName(asset.file_url),
    uploadedAt: asset.created_at,
    signedUrl,
    signedUrlFailed: signedUrl === null,
  };
}

function joinMultiline(values: Array<string | null | undefined>): string {
  return values.filter((v): v is string => Boolean(v && v.trim())).join("\n");
}

export function mapImageTypeRows(input: {
  description: string | null;
  characterName: string | null;
  referenceFile: boolean;
  consentGranted: boolean;
}): AdminTypeDetailRow[] {
  const rows: AdminTypeDetailRow[] = [];
  rows.push({ label: "شخصیت", value: input.characterName || "ثبت نشده" });
  rows.push({
    label: "توضیح والد",
    value: joinMultiline([input.description]) || "ثبت نشده",
    multiline: true,
  });
  rows.push({ label: "فایل مرجع", value: input.referenceFile ? "بارگذاری شده" : "بارگذاری نشده" });
  rows.push({ label: "رضایت والد", value: input.consentGranted ? "ثبت شده" : "ثبت نشده" });
  return rows;
}

export function mapVideoTypeRows(input: {
  description: string | null;
  characterName: string | null;
  script: string | null;
  style: string | null;
  referenceFile: boolean;
  consentGranted: boolean;
}): AdminTypeDetailRow[] {
  const rows: AdminTypeDetailRow[] = [];
  rows.push({ label: "شخصیت", value: input.characterName || "ثبت نشده" });
  rows.push({ label: "سناریو", value: input.script || "ثبت نشده", multiline: true });
  rows.push({ label: "سبک ویدیو", value: input.style || "ثبت نشده" });
  rows.push({
    label: "توضیح والد",
    value: joinMultiline([input.description]) || "ثبت نشده",
    multiline: true,
  });
  rows.push({ label: "فایل مرجع", value: input.referenceFile ? "بارگذاری شده" : "بارگذاری نشده" });
  rows.push({ label: "رضایت والد", value: input.consentGranted ? "ثبت شده" : "ثبت نشده" });
  return rows;
}

export function mapDrawingTypeRows(input: {
  description: string | null;
  animationStyle: string | null;
  sourceDrawing: boolean;
  consentGranted: boolean;
}): AdminTypeDetailRow[] {
  const rows: AdminTypeDetailRow[] = [];
  rows.push({ label: "سبک انیمیشن", value: input.animationStyle || "ثبت نشده" });
  rows.push({
    label: "توضیح والد",
    value: joinMultiline([input.description]) || "ثبت نشده",
    multiline: true,
  });
  rows.push({ label: "نقاشی منبع", value: input.sourceDrawing ? "بارگذاری شده" : "بارگذاری نشده" });
  rows.push({ label: "رضایت والد", value: input.consentGranted ? "ثبت شده" : "ثبت نشده" });
  return rows;
}

export interface OrderDetailInput {
  id: string;
  type: string | null;
  status: string | null;
  title: string;
  description: string | null;
  candy_cost: number | null;
  moderation_status: string | null;
  created_at: string;
  updated_at: string;
  parentFullName: string | null;
  parentEmail: string | null;
  parentProfileMissing: boolean;
  childProfileId: string | null;
  characterName: string | null;
  consentGranted: boolean;
  typeRows: AdminTypeDetailRow[];
  media: AdminMediaAssetInfo[];
}

export function mapOrderDetail(input: OrderDetailInput): AdminOrderDetail {
  return {
    id: input.id,
    type: isKnownOrderType(input.type) ? input.type : null,
    typeLabel: mapRequestTypeLabel(input.type),
    status: isKnownOrderStatus(input.status) ? input.status : null,
    statusLabel: mapOrderStatusLabel(input.status),
    title: input.title,
    description: input.description,
    candyCost: input.candy_cost ?? 0,
    moderationStatus: input.moderation_status ?? "",
    moderationStatusLabel: mapModerationStatusLabel(input.moderation_status),
    createdAt: input.created_at,
    updatedAt: input.updated_at,
    parent: mapParentInfo(input.parentFullName, input.parentEmail, input.parentProfileMissing),
    childLabel: mapChildProfileLabel(input.childProfileId),
    characterName: input.characterName,
    typeRows: input.typeRows,
    consentGranted: input.consentGranted,
    media: input.media,
  };
}

export function parentDeletedLabel(parent: AdminParentInfo): string {
  return parent.deleted ? PARENT_DELETED_LABEL : (parent.name || "نام ثبت نشده");
}

export function mapQueueRow(input: {
  id: string;
  type: string | null;
  status: string | null;
  title: string;
  candy_cost: number | null;
  created_at: string;
  updated_at: string;
  parentFullName: string | null;
  parentProfileMissing: boolean;
  childProfileId: string | null;
}): AdminQueueRow {
  const parent = mapParentInfo(input.parentFullName, null, input.parentProfileMissing);
  return {
    id: input.id,
    type: isKnownOrderType(input.type) ? input.type : null,
    typeLabel: mapRequestTypeLabel(input.type),
    status: isKnownOrderStatus(input.status) ? input.status : null,
    statusLabel: mapOrderStatusLabel(input.status),
    title: input.title,
    parentName: parent.name,
    parentDeleted: parent.deleted,
    childLabel: mapChildProfileLabel(input.childProfileId),
    candyCost: input.candy_cost ?? 0,
    createdAt: input.created_at,
    updatedAt: input.updated_at,
  };
}

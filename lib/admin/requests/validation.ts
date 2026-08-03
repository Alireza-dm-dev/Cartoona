import type { OrderStatus, OrderType } from "@/types/app";
import { KNOWN_ORDER_STATUSES, KNOWN_ORDER_TYPES } from "@/lib/admin/requests/mappers";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;

export interface ParsedQueueParams {
  type: OrderType | null;
  status: OrderStatus | null;
  page: number;
  pageSize: number;
}

function firstString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : value[0] ?? null;
}

export function parseTypeFilter(value: string | string[] | undefined): OrderType | null {
  const raw = firstString(value);
  if (!raw) return null;
  return (KNOWN_ORDER_TYPES as readonly string[]).includes(raw) ? (raw as OrderType) : null;
}

export function parseStatusFilter(value: string | string[] | undefined): OrderStatus | null {
  const raw = firstString(value);
  if (!raw) return null;
  return (KNOWN_ORDER_STATUSES as readonly string[]).includes(raw) ? (raw as OrderStatus) : null;
}

export function parsePageNumber(value: string | string[] | undefined): number {
  const raw = firstString(value);
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function parsePageSize(value: string | string[] | undefined): number {
  const raw = firstString(value);
  if (!raw) return DEFAULT_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function clampPage(page: number, totalPages: number): number {
  if (totalPages <= 0) return 1;
  return Math.max(1, Math.min(page, totalPages));
}

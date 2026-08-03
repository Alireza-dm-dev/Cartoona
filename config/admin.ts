import type { OrderType } from "@/types/app";

export const adminRequestTypeLabels: Record<OrderType, string> = {
  image: "تصویر",
  video: "ویدیو",
  drawing_animation: "انیمیشن نقاشی",
};

export const UNKNOWN_REQUEST_TYPE_LABEL = "نوع نامشخص";


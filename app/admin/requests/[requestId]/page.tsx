import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { queryAdminRequestDetail } from "@/lib/admin/requests/queries";
import { parentDeletedLabel } from "@/lib/admin/requests/mappers";
import { isKnownOrderStatus } from "@/lib/admin/requests/mappers";
import {
  getAllowedNextStatuses,
  canUploadFinalMedia,
} from "@/lib/admin/requests/workflow";
import {
  loadAdminFinalMedia,
  loadAdminFulfilmentHistory,
} from "@/lib/admin/requests/fulfilment-service";
import { StatusUpdateForm } from "@/components/admin/requests/status-update-form";
import { FinalMediaUpload } from "@/components/admin/requests/final-media-upload";
import { FulfilmentTimeline } from "@/components/admin/requests/fulfilment-timeline";
import type { AdminMediaAssetInfo } from "@/lib/admin/requests/types";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "—";
  }
}

function isPreviewableImage(asset: AdminMediaAssetInfo): boolean {
  return !!asset.signedUrl && (asset.mimeType?.startsWith("image/") ?? false);
}

function isPreviewableVideo(asset: AdminMediaAssetInfo): boolean {
  return !!asset.signedUrl && (asset.mimeType === "video/mp4" || asset.mimeType === "video/webm");
}

export default async function AdminRequestDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;

  if (!UUID_REGEX.test(requestId)) {
    notFound();
  }

  const supabase = await createServerSupabaseClient();
  const [detail, finalMedia, history] = await Promise.all([
    queryAdminRequestDetail(supabase, { requestId }),
    loadAdminFinalMedia(supabase, requestId),
    loadAdminFulfilmentHistory(supabase, requestId),
  ]);

  if (!detail) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-[960px]">
      <PageHeader
        title="جزئیات درخواست"
        description="بررسی اطلاعات درخواست والد، فایل‌های ورودی و جزئیات نوع درخواست."
      />

      <div className="flex flex-col gap-6">
        <Card variant="admin">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-parent-navy">{detail.title}</h2>
                <span dir="ltr" className="text-xs text-text-dark/40">
                  {detail.id}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge variant="default">{detail.typeLabel}</Badge>
                {isKnownOrderStatus(detail.status) ? (
                  <OrderStatusBadge status={detail.status} />
                ) : (
                  <Badge variant="default">{detail.statusLabel}</Badge>
                )}
                <Badge variant="default">{detail.moderationStatusLabel}</Badge>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <span className="text-text-dark/50">والد:</span>
                  <span className="mr-1 text-text-dark">{parentDeletedLabel(detail.parent)}</span>
                </div>
                <div>
                  <span className="text-text-dark/50">کودک:</span>
                  <span className="mr-1 text-text-dark">{detail.childLabel}</span>
                </div>
                <div>
                  <span className="text-text-dark/50">تاریخ ثبت:</span>
                  <span className="mr-1 text-text-dark">{formatDate(detail.createdAt)}</span>
                </div>
                <div>
                  <span className="text-text-dark/50">آخرین به‌روزرسانی:</span>
                  <span className="mr-1 text-text-dark">{formatDate(detail.updatedAt)}</span>
                </div>
                <div>
                  <span className="text-text-dark/50">هزینه:</span>
                  <span className="mr-1 text-text-dark">{detail.candyCost} آبنبات</span>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card variant="admin">
          <h2 className="mb-3 font-semibold text-parent-navy">اطلاعات والد</h2>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <span className="text-text-dark/50">نام:</span>
              <span className="mr-1 text-text-dark">{parentDeletedLabel(detail.parent)}</span>
            </div>
            <div>
              <span className="text-text-dark/50">ایمیل:</span>
              <span dir="ltr" className="mr-1 text-text-dark">
                {detail.parent.email || "ثبت نشده"}
              </span>
            </div>
          </div>
        </Card>

        {detail.description && (
          <Card variant="admin">
            <h2 className="mb-3 font-semibold text-parent-navy">توضیح والد</h2>
            <p className="whitespace-pre-line text-sm text-text-dark">{detail.description}</p>
          </Card>
        )}

        <Card variant="admin">
          <h2 className="mb-3 font-semibold text-parent-navy">جزئیات درخواست</h2>
          <div className="flex flex-col gap-3 text-sm">
            {detail.characterName && (
              <div>
                <p className="text-text-dark/50">شخصیت</p>
                <p className="mt-0.5 text-text-dark">{detail.characterName}</p>
              </div>
            )}
            {detail.typeRows.map((row) => (
              <div key={row.label}>
                <p className="text-text-dark/50">{row.label}</p>
                <p className={`mt-0.5 text-text-dark ${row.multiline ? "whitespace-pre-line" : ""}`}>
                  {row.value}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card variant="admin">
          <h2 className="mb-3 font-semibold text-parent-navy">فایل‌های ورودی</h2>
          {detail.media.length === 0 ? (
            <p className="text-sm text-text-dark/40">هیچ فایلی بارگذاری نشده است.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {detail.media.map((asset) => (
                <div
                  key={asset.id}
                  className="flex flex-col gap-2 rounded-lg border border-soft-border p-3 sm:flex-row sm:items-center"
                >
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="default">بارگذاری والد</Badge>
                      {asset.mimeType && (
                        <span className="text-xs text-text-dark/40">{asset.mimeType}</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-text-dark/50">
                      {asset.fileName ?? "فایل بدون نام"} — {formatDate(asset.uploadedAt)}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {asset.signedUrlFailed ? (
                      <span className="text-xs text-coral">فایل در حال حاضر در دسترس نیست.</span>
                    ) : asset.signedUrl && isPreviewableImage(asset) ? (
                      <img
                        src={asset.signedUrl}
                        alt={asset.fileName ?? "پیش‌نمایش فایل"}
                        className="h-24 w-32 rounded-lg border border-soft-border object-cover"
                      />
                    ) : asset.signedUrl && isPreviewableVideo(asset) ? (
                      <video src={asset.signedUrl} controls className="h-24 w-32 rounded-lg border border-soft-border bg-black" />
                    ) : asset.signedUrl ? (
                      <a href={asset.signedUrl} target="_blank" rel="noopener noreferrer" download>
                        <Button variant="secondary" size="sm">دانلود / باز کردن</Button>
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <FinalMediaUpload
          requestId={requestId}
          canUpload={canUploadFinalMedia(detail.status)}
          assets={finalMedia}
        />

        <StatusUpdateForm
          requestId={requestId}
          currentStatus={detail.status}
          expectedUpdatedAt={detail.updatedAt}
          allowedNext={getAllowedNextStatuses(detail.status)}
        />

        <FulfilmentTimeline history={history ?? []} />

        <div className="flex justify-start">
          <Link href="/admin/requests">
            <Button variant="secondary">بازگشت به صف درخواست‌ها</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/admin/coupons/confirm-dialog"
import type { AdminFinalMediaInfo } from "@/lib/admin/requests/fulfilment-types"
import {
  validateFinalMediaFile,
  MAX_FINAL_FILES_PER_UPLOAD,
} from "@/lib/admin/requests/media-validation"

interface FinalMediaUploadProps {
  requestId: string
  canUpload: boolean
  assets: AdminFinalMediaInfo[]
}

interface ConfirmAction {
  kind: "approve" | "supersede"
  assetId: string
  fileName: string
}

function deliveryBadge(asset: AdminFinalMediaInfo) {
  if (asset.deliveryStatus === "approved") {
    return <Badge variant="success">تأیید شده</Badge>
  }
  if (asset.deliveryStatus === "superseded") {
    return <Badge variant="default">جایگزین شده</Badge>
  }
  return <Badge variant="warning">در انتظار تأیید</Badge>
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return "—"
    return d.toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" })
  } catch {
    return "—"
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} بایت`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} کیلوبایت`
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`
}

function isPreviewableImage(asset: AdminFinalMediaInfo): boolean {
  return !!asset.signedUrl && (asset.mimeType?.startsWith("image/") ?? false)
}

function isPreviewableVideo(asset: AdminFinalMediaInfo): boolean {
  return !!asset.signedUrl && (asset.mimeType === "video/mp4" || asset.mimeType === "video/webm")
}

/**
 * Final deliverables: upload + approval/supersede. Files are validated client-
 * side (fail fast) and again by the trusted RPC; the private bucket enforces
 * size/MIME limits. Parent visibility only turns on after explicit approval.
 */
export function FinalMediaUpload({ requestId, canUpload, assets }: FinalMediaUploadProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [confirmLoading, setConfirmLoading] = useState(false)

  function onPick(selected: FileList | null) {
    setFileError(null)
    if (!selected) return
    const list = Array.from(selected)
    if (list.length > MAX_FINAL_FILES_PER_UPLOAD) {
      setFileError(`حداکثر ${MAX_FINAL_FILES_PER_UPLOAD} فایل در هر بار ارسال مجاز است.`)
      return
    }
    for (const file of list) {
      const validated = validateFinalMediaFile(file)
      if (!validated.ok) {
        setFileError(`${file.name}: ${validated.error}`)
        return
      }
    }
    setFiles(list)
  }

  async function handleUpload() {
    setFileError(null)
    setActionError(null)
    if (files.length === 0) {
      setFileError("فایلی برای ارسال انتخاب نشده است.")
      return
    }

    const form = new FormData()
    for (const file of files) {
      form.append("files", file)
    }

    setUploading(true)
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/final-media`, {
        method: "POST",
        body: form,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setActionError(body?.error ?? "بارگذاری فایل انجام نشد.")
        return
      }
      setFiles([])
      if (inputRef.current) inputRef.current.value = ""
      router.refresh()
    } catch {
      setActionError("بارگذاری فایل انجام نشد. لطفاً دوباره تلاش کنید.")
    } finally {
      setUploading(false)
    }
  }

  async function runConfirm() {
    if (!confirm) return
    setConfirmLoading(true)
    setActionError(null)
    try {
      const res = await fetch(
        `/api/admin/requests/${requestId}/final-media/${confirm.assetId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: confirm.kind }),
        },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setActionError(body?.error ?? "اعمال تغییر انجام نشد.")
        return
      }
      setConfirm(null)
      router.refresh()
    } catch {
      setActionError("اعمال تغییر انجام نشد. لطفاً دوباره تلاش کنید.")
    } finally {
      setConfirmLoading(false)
    }
  }

  return (
    <Card variant="admin">
      <div className="mb-4">
        <h2 className="font-semibold text-parent-navy">فایل‌های خروجی نهایی</h2>
        <p className="mt-1 text-sm text-text-dark/60">
          فایل‌ها تا تأیید مدیر برای والد نمایش داده نمی‌شوند. پس از تأیید حداقل یک فایل، می‌توانید وضعیت
          را به «آماده تحویل» تغییر دهید.
        </p>
      </div>

      {canUpload && (
        <div className="mb-5 flex flex-col gap-3">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
            className="block w-full cursor-pointer rounded-xl border border-dashed border-soft-border bg-white px-3 py-4 text-sm text-text-dark/70 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-candy-pink file:px-4 file:py-2 file:text-sm file:font-medium file:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy"
            onChange={(e) => onPick(e.target.files)}
            disabled={uploading}
          />
          <div className="flex flex-wrap items-center gap-3">
            {files.length > 0 && (
              <span className="text-xs text-text-dark/50">{files.length} فایل انتخاب شده</span>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleUpload} disabled={uploading || files.length === 0}>
                {uploading ? "در حال بارگذاری..." : "بارگذاری فایل‌ها"}
              </Button>
              {files.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFiles([])
                    setFileError(null)
                    if (inputRef.current) inputRef.current.value = ""
                  }}
                  disabled={uploading}
                >
                  پاک کردن
                </Button>
              )}
            </div>
          </div>
          {fileError && <p className="text-xs text-coral">{fileError}</p>}
        </div>
      )}

      {!canUpload && assets.length > 0 && (
        <p className="mb-5 rounded-lg border border-soft-border bg-soft-border/20 px-3 py-2 text-xs text-text-dark/60">
          در وضعیت فعلی، بارگذاری فایل جدید امکان‌پذیر نیست.
        </p>
      )}

      {actionError && (
        <p className="mb-4 rounded-lg border border-coral/20 bg-coral/5 px-3 py-2 text-sm text-coral">
          {actionError}
        </p>
      )}

      {assets.length === 0 ? (
        <p className="text-sm text-text-dark/40">هنوز فایلی بارگذاری نشده است.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="flex flex-col gap-3 rounded-lg border border-soft-border p-3 sm:flex-row sm:items-center"
            >
              <div className="shrink-0">
                {asset.signedUrlFailed ? (
                  <span className="text-xs text-coral">در دسترس نیست.</span>
                ) : asset.signedUrl && isPreviewableImage(asset) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={asset.signedUrl}
                    alt={asset.fileName ?? "پیش‌نمایش فایل"}
                    className="h-24 w-32 rounded-lg border border-soft-border object-cover"
                  />
                ) : asset.signedUrl && isPreviewableVideo(asset) ? (
                  <video
                    src={asset.signedUrl}
                    controls
                    className="h-24 w-32 rounded-lg border border-soft-border bg-black"
                  />
                ) : asset.signedUrl ? (
                  <a href={asset.signedUrl} target="_blank" rel="noopener noreferrer" download>
                    <Button variant="secondary" size="sm">دانلود</Button>
                  </a>
                ) : null}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {deliveryBadge(asset)}
                  <span className="text-xs text-text-dark/40">{asset.mimeType ?? "—"}</span>
                </div>
                <div className="mt-1 text-xs text-text-dark/50">
                  {asset.fileName ?? "فایل بدون نام"} — {formatDate(asset.uploadedAt)}
                  {asset.byteSize !== null ? ` (${formatBytes(asset.byteSize)})` : ""}
                </div>
                {asset.deliveryStatus === "approved" && (
                  <p className="mt-1 text-xs text-mint-green">
                    این فایل برای والد قابل مشاهده است.
                  </p>
                )}
                {asset.deliveryStatus === "superseded" && (
                  <p className="mt-1 text-xs text-text-dark/40">
                    جایگزین شده و دیگر برای والد نمایش داده نمی‌شود.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {asset.deliveryStatus === "uploaded" && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      setConfirm({ kind: "approve", assetId: asset.id, fileName: asset.fileName ?? "فایل" })
                    }
                  >
                    تأیید برای والد
                  </Button>
                )}
                {(asset.deliveryStatus === "uploaded" || asset.deliveryStatus === "approved") && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setConfirm({ kind: "supersede", assetId: asset.id, fileName: asset.fileName ?? "فایل" })
                    }
                  >
                    جایگزین با نسخه جدید
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "approve" ? "تأیید فایل برای والد" : "جایگزینی فایل"}
        description={
          confirm?.kind === "approve"
            ? `«${confirm?.fileName ?? "فایل"}» پس از تأیید برای والد قابل مشاهده می‌شود.`
            : `«${confirm?.fileName ?? "فایل"}» جایگزین شده و دیگر برای والد نمایش داده نمی‌شود. این عمل قابل بازگشت نیست.`
        }
        confirmLabel={confirm?.kind === "approve" ? "تأیید نهایی" : "جایگزین کن"}
        danger={confirm?.kind === "supersede"}
        loading={confirmLoading}
        onConfirm={runConfirm}
        onCancel={() => {
          if (!confirmLoading) setConfirm(null)
        }}
      />
    </Card>
  )
}

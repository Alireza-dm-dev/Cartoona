"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { createBrowserSupabaseClient } from "@/lib/supabase/client"
import type { ExampleKind } from "@/types/app"
import type { DbExample } from "@/types/database"

const EXAMPLE_MEDIA_BUCKET = "example-media"
const MAX_FILE_SIZE = 10 * 1024 * 1024
const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"]

const kindOptions = [
  { value: "story", label: "داستان تصویری" },
  { value: "video", label: "نمونه ویدیویی" },
  { value: "drawing", label: "متحرک‌سازی نقاشی" },
]

const kindBadgeFallback: Record<string, string> = {
  video: "نمونه ویدیویی",
  drawing: "متحرک‌سازی نقاشی",
  story: "داستان تصویری",
}

type ExampleFormMode = "create" | "edit"

interface ExampleFormProps {
  mode: ExampleFormMode
  initialExample?: DbExample
}

interface FieldErrors {
  title?: string
  badge_label?: string
  description?: string
  kind?: string
  sort_order?: string
  image?: string
}

function getPublicUrl(path: string): string {
  const supabase = createBrowserSupabaseClient()
  const { data } = supabase.storage.from(EXAMPLE_MEDIA_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export function ExampleForm({ mode, initialExample }: ExampleFormProps) {
  const router = useRouter()
  const [title, setTitle] = useState(initialExample?.title ?? "")
  const [badgeLabel, setBadgeLabel] = useState(initialExample?.badge_label ?? "")
  const [description, setDescription] = useState(initialExample?.description ?? "")
  const [kind, setKind] = useState<ExampleKind>(initialExample?.kind ?? "story")
  const [sortOrder, setSortOrder] = useState(String(initialExample?.sort_order ?? 0))
  const [isPublished, setIsPublished] = useState(initialExample?.is_published ?? false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const existingImageUrl = mode === "edit" && initialExample?.media_url
    ? getPublicUrl(initialExample.media_url)
    : null

  const previewImageUrl = imagePreview ?? existingImageUrl
  const previewBadge = badgeLabel.trim() || kindBadgeFallback[kind]

  function validate(): FieldErrors {
    const e: FieldErrors = {}
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      e.title = "عنوان الزامی است"
    } else if (trimmedTitle.length > 120) {
      e.title = "عنوان حداکثر ۱۲۰ کاراکتر می‌تواند باشد"
    }
    if (badgeLabel.length > 40) {
      e.badge_label = "برچسب حداکثر ۴۰ کاراکتر می‌تواند باشد"
    }
    const trimmedDesc = description.trim()
    if (!trimmedDesc) {
      e.description = "توضیح الزامی است"
    } else if (trimmedDesc.length > 1000) {
      e.description = "توضیح حداکثر ۱۰۰۰ کاراکتر می‌تواند باشد"
    }
    if (!kind) {
      e.kind = "نوع نمونه الزامی است"
    }
    const sortNum = parseInt(sortOrder, 10)
    if (isNaN(sortNum) || sortNum < 0 || sortNum > 10000) {
      e.sort_order = "ترتیب نمایش باید عددی بین ۰ تا ۱۰۰۰۰ باشد"
    }
    if (mode === "create" && !imageFile) {
      e.image = "تصویر نمونه الزامی است"
    }
    if (imageFile && !ACCEPTED_MIME_TYPES.includes(imageFile.type)) {
      e.image = "فقط فرمت‌های PNG، JPEG و WebP مجاز هستند"
    }
    if (imageFile && imageFile.size > MAX_FILE_SIZE) {
      e.image = "حداکثر حجم مجاز ۱۰ مگابایت است"
    }
    return e
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setServerError(null)

    const fieldErrors = validate()
    setErrors(fieldErrors)
    if (Object.keys(fieldErrors).length > 0) return

    setSubmitting(true)

    try {
      if (mode === "create") {
        const formData = new FormData()
        formData.append("title", title.trim())
        formData.append("badge_label", badgeLabel.trim())
        formData.append("description", description.trim())
        formData.append("kind", kind)
        formData.append("sort_order", sortOrder)
        formData.append("is_published", String(isPublished))
        if (imageFile) formData.append("image", imageFile)

        const res = await fetch("/api/admin/examples", {
          method: "POST",
          body: formData,
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || "ثبت نمونه با خطا مواجه شد")
        }

        router.push("/admin/examples")
        router.refresh()
      } else if (mode === "edit" && initialExample) {
        const metadata: Record<string, unknown> = {}
        if (title.trim() !== initialExample.title) metadata.title = title.trim()
        if (badgeLabel.trim() !== initialExample.badge_label) metadata.badge_label = badgeLabel.trim()
        if (description.trim() !== (initialExample.description ?? "")) metadata.description = description.trim()
        if (kind !== initialExample.kind) metadata.kind = kind
        const sortNum = parseInt(sortOrder, 10)
        if (sortNum !== initialExample.sort_order) metadata.sort_order = sortNum
        if (isPublished !== initialExample.is_published) metadata.is_published = isPublished

        if (Object.keys(metadata).length > 0) {
          const metaRes = await fetch(`/api/admin/examples/${initialExample.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metadata),
          })
          if (!metaRes.ok) {
            const body = await metaRes.json().catch(() => ({}))
            throw new Error(body.error || "ویرایش اطلاعات با خطا مواجه شد")
          }
        }

        if (imageFile) {
          const mediaForm = new FormData()
          mediaForm.append("image", imageFile)
          const mediaRes = await fetch(`/api/admin/examples/${initialExample.id}/media`, {
            method: "PUT",
            body: mediaForm,
          })
          if (!mediaRes.ok) {
            setServerError("اطلاعات ذخیره شد اما جایگزینی تصویر با خطا مواجه شد. لطفاً دوباره تلاش کنید.")
            setSubmitting(false)
            return
          }
        }

        router.push("/admin/examples")
        router.refresh()
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "عملیات با خطا مواجه شد")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {serverError && (
        <Card variant="admin" className="border-coral/20 bg-coral/5">
          <p className="text-sm text-coral" role="alert">{serverError}</p>
        </Card>
      )}

      <Card variant="admin" className="space-y-5">
        <h3 className="text-base font-bold text-parent-navy border-b border-soft-border pb-3">
          محتوای کارت در صفحه نمونه‌ها
        </h3>

        <div className="space-y-2">
          <label htmlFor="title" className="block text-sm font-medium text-text-dark">
            عنوان <span className="text-coral">*</span>
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10"
            maxLength={120}
          />
          {errors.title && <p className="text-xs text-coral" role="alert">{errors.title}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="description" className="block text-sm font-medium text-text-dark">
            توضیح <span className="text-coral">*</span>
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10 resize-y"
            maxLength={1000}
          />
          {errors.description && <p className="text-xs text-coral" role="alert">{errors.description}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="badge_label" className="block text-sm font-medium text-text-dark">
            برچسب کارت
          </label>
          <input
            id="badge_label"
            type="text"
            value={badgeLabel}
            onChange={(e) => setBadgeLabel(e.target.value)}
            placeholder="مثلاً: نقاشی متحرک"
            className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10"
            maxLength={40}
          />
          <p className="text-xs text-text-dark/50">حداکثر ۴۰ کاراکتر. در صورت خالی بودن، برچسب پیش‌فرض نوع نمونه نمایش داده می‌شود.</p>
          {errors.badge_label && <p className="text-xs text-coral" role="alert">{errors.badge_label}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="image" className="block text-sm font-medium text-text-dark">
            {mode === "create" ? "تصویر نمونه" : "جایگزینی تصویر"}
            {mode === "create" && <span className="text-coral"> *</span>}
          </label>
          <input
            id="image"
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null
              setImageFile(file)
              if (file) {
                setImagePreview(URL.createObjectURL(file))
              } else {
                setImagePreview(null)
              }
            }}
            className="w-full text-sm text-text-dark file:ml-3 file:rounded-lg file:border-0 file:bg-soft-border/50 file:px-3 file:py-1.5 file:text-sm file:text-text-dark hover:file:bg-soft-border/80"
          />
          <p className="text-xs text-text-dark/50">حداکثر حجم مجاز ۱۰ مگابایت است.</p>
          {errors.image && <p className="text-xs text-coral" role="alert">{errors.image}</p>}
        </div>
      </Card>

      <Card variant="admin" className="space-y-5">
        <h3 className="text-base font-bold text-parent-navy border-b border-soft-border pb-3">
          تنظیمات مدیریتی
        </h3>

        <div className="space-y-2">
          <label htmlFor="kind" className="block text-sm font-medium text-text-dark">
            نوع نمونه <span className="text-coral">*</span>
          </label>
          <select
            id="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExampleKind)}
            className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10"
          >
            {kindOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {errors.kind && <p className="text-xs text-coral" role="alert">{errors.kind}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="sort_order" className="block text-sm font-medium text-text-dark">
            ترتیب نمایش <span className="text-coral">*</span>
          </label>
          <input
            id="sort_order"
            type="number"
            min={0}
            max={10000}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10"
          />
          {errors.sort_order && <p className="text-xs text-coral" role="alert">{errors.sort_order}</p>}
        </div>

        <div className="flex items-center gap-3">
          <input
            id="is_published"
            type="checkbox"
            checked={isPublished}
            onChange={(e) => setIsPublished(e.target.checked)}
            className="h-4 w-4 rounded border-soft-border text-candy-pink focus:ring-candy-pink/20"
          />
          <label htmlFor="is_published" className="text-sm font-medium text-text-dark">
            نمایش در صفحه عمومی
          </label>
        </div>
      </Card>

      <Card variant="admin" className="space-y-4">
        <h3 className="text-sm font-bold text-parent-navy border-b border-soft-border pb-3">
          پیش‌نمایش کارت
        </h3>
        <div className="max-w-sm rounded-2xl border border-soft-border bg-white p-4 shadow-sm">
          <div className="mb-3 aspect-video overflow-hidden rounded-2xl bg-soft-border/30">
            {previewImageUrl ? (
              <img
                src={previewImageUrl}
                alt={title || "پیش‌نمایش"}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-text-dark/20">
                تصویری انتخاب نشده
              </div>
            )}
          </div>
          <div className="mb-2">
            <Badge variant="default" size="sm">{previewBadge}</Badge>
          </div>
          <h4 className="font-semibold text-text-dark">{title || "عنوان نمونه"}</h4>
          {description && (
            <p className="mt-1 text-sm text-text-dark/60">{description}</p>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "در حال ذخیره…" : mode === "create" ? "افزودن نمونه" : "ذخیره تغییرات"}
        </Button>
        <Link href="/admin/examples">
          <Button type="button" variant="secondary">انصراف</Button>
        </Link>
      </div>
    </form>
  )
}

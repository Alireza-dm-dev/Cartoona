"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { createBrowserSupabaseClient } from "@/lib/supabase/client"
import type { DbExample } from "@/types/database"

const EXAMPLE_MEDIA_BUCKET = "example-media"

const kindLabels: Record<string, string> = {
  video: "نمونه ویدیویی",
  drawing: "متحرک‌سازی نقاشی",
  story: "داستان تصویری",
}

function badgeText(example: DbExample): string {
  return example.badge_label || kindLabels[example.kind] || example.kind
}

function getPublicUrl(path: string): string {
  const supabase = createBrowserSupabaseClient()
  const { data } = supabase.storage.from(EXAMPLE_MEDIA_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

interface ExampleListProps {
  initialExamples: DbExample[]
}

export function ExampleList({ initialExamples }: ExampleListProps) {
  const router = useRouter()
  const [examples, setExamples] = useState<DbExample[]>(initialExamples)
  const [processingId, setProcessingId] = useState<string | null>(null)

  async function handlePublish(example: DbExample) {
    setProcessingId(example.id)
    try {
      const res = await fetch(`/api/admin/examples/${example.id}/publish`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_published: !example.is_published }),
      })
      if (!res.ok) throw new Error()
      router.refresh()
    } catch {
      alert("عملیات انتشار با خطا مواجه شد. لطفاً دوباره تلاش کنید.")
    } finally {
      setProcessingId(null)
    }
  }

  async function handleDelete(example: DbExample) {
    if (!window.confirm("این نمونه و تصویر آن به‌صورت دائمی حذف می‌شوند. آیا مطمئن هستید؟")) {
      return
    }
    setProcessingId(example.id)
    try {
      const res = await fetch(`/api/admin/examples/${example.id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      setExamples((prev) => prev.filter((e) => e.id !== example.id))
      router.refresh()
    } catch {
      alert("حذف نمونه با خطا مواجه شد. لطفاً دوباره تلاش کنید.")
    } finally {
      setProcessingId(null)
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {examples.map((example) => {
        const publicUrl = getPublicUrl(example.media_url)
        return (
          <Card key={example.id} variant="admin">
            <Link
              href={`/admin/examples/${example.id}`}
              className="mb-3 block aspect-video overflow-hidden rounded-lg bg-soft-border/50"
            >
              <img
                src={publicUrl}
                alt={`تصویر نمونه ${example.title}`}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </Link>

            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="default" size="sm">
                {badgeText(example)}
              </Badge>
              <Badge variant="info" size="sm">
                {kindLabels[example.kind] || example.kind}
              </Badge>
              {example.is_published ? (
                <Badge variant="success" size="sm">منتشر شده</Badge>
              ) : (
                <Badge variant="warning" size="sm">پیش‌نویس</Badge>
              )}
            </div>

            <Link
              href={`/admin/examples/${example.id}`}
              className="font-semibold text-text-dark hover:text-candy-pink transition-colors"
            >
              {example.title}
            </Link>

            <div className="mt-2 flex flex-col gap-1 text-xs text-text-dark/50">
              <div className="flex justify-between">
                <span>ترتیب</span>
                <span className="text-text-dark/70" dir="ltr">{example.sort_order}</span>
              </div>
              <div className="flex justify-between">
                <span>بروزرسانی</span>
                <span className="text-text-dark/70">{new Date(example.updated_at).toLocaleDateString("fa-IR")}</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-soft-border pt-3">
              <Link href={`/admin/examples/${example.id}`}>
                <Button variant="secondary" size="sm">ویرایش</Button>
              </Link>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handlePublish(example)}
                disabled={processingId === example.id}
              >
                {example.is_published ? "عدم نمایش در سایت" : "انتشار در سایت"}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleDelete(example)}
                disabled={processingId === example.id}
              >
                حذف نمونه
              </Button>
            </div>
          </Card>
        )
      })}
    </div>
  )
}

import Link from "next/link"
import { PageHeader } from "@/components/ui/page-header"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SafetyNotice } from "@/components/ui/safety-notice"
import { EmptyState } from "@/components/ui/empty-state"
import { createServerSupabaseClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

const KIND_LABELS: Record<string, string> = {
  video: "نمونه ویدیویی",
  drawing: "متحرک‌سازی نقاشی",
  story: "داستان تصویری",
}

const KIND_GRADIENTS: Record<string, string> = {
  video: "from-sky-blue/20 to-soft-purple/20",
  drawing: "from-mint-green/20 to-sunshine-yellow/20",
  story: "from-candy-pink/20 to-sky-blue/20",
}

export default async function ExamplesPage() {
  const supabase = await createServerSupabaseClient()

  const { data: examples, error } = await supabase
    .from("examples")
    .select("*")
    .eq("is_published", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-16">
      <PageHeader
        title="نمونه‌های کارتونی"
        description="چند نمونه از تجربه‌هایی که والدین می‌توانند در کارتونا درخواست کنند؛ امن، خصوصی و بدون استفاده از تصویر واقعی کودکان."
      />

      {error ? (
        <Card variant="admin" className="border-coral/20 bg-coral/5">
          <div className="flex items-start gap-3">
            <span className="text-xl" aria-hidden="true">⚠️</span>
            <div>
              <h3 className="font-semibold text-parent-navy">نمایش نمونه‌ها ممکن نیست</h3>
              <p className="mt-1 text-sm text-text-dark/70">
                در حال حاضر دریافت نمونه‌ها با مشکل روبه‌رو شده است. کمی بعد دوباره تلاش کنید.
              </p>
            </div>
          </div>
        </Card>
      ) : examples.length === 0 ? (
        <EmptyState
          title="هنوز نمونه‌ای منتشر نشده است"
          description="نمونه‌های جدید کارتونا به‌زودی در این بخش نمایش داده می‌شوند."
          action={
            <Link href="/#creation-types">
              <Button variant="primary" size="lg">شروع ساخت کارتون</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {examples.map((example) => {
            const gradient = KIND_GRADIENTS[example.kind] || "from-soft-border/50 to-cream"
            let imageUrl: string | null = null
            if (example.media_url) {
              const { data } = supabase.storage
                .from("example-media")
                .getPublicUrl(example.media_url)
              imageUrl = data.publicUrl
            }

            return (
              <Card key={example.id}>
                <div className={`mb-3 aspect-video overflow-hidden rounded-2xl bg-gradient-to-br ${gradient}`}>
                  {imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl}
                      alt={example.title}
                      className="h-full w-full object-cover"
                      width={560}
                      height={315}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-text-dark/20">
                      پیش‌نمایش
                    </div>
                  )}
                </div>
                <h3 className="font-semibold text-text-dark">{example.title}</h3>
                {example.description && (
                  <p className="mt-1 text-sm text-text-dark/60">{example.description}</p>
                )}
                <Badge variant="default" size="sm" className="mt-3">
                  {example.badge_label || KIND_LABELS[example.kind] || example.kind}
                </Badge>
              </Card>
            )
          })}
        </div>
      )}

      <div className="mt-8">
        <SafetyNotice title="ایمنی و حریم خصوصی">
          تمام نمونه‌های نمایش‌داده‌شده خیالی هستند. محتوای خانواده شما در
          کارتونا کاملاً خصوصی و فقط در داشبورد والدین قابل مشاهده است.
        </SafetyNotice>
      </div>

      <div className="mt-16 text-center">
        <h2 className="text-2xl font-bold text-parent-navy">
          می‌خواهید اولین نمونه خودتان را بسازید؟
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-text-dark/70">
          از یک مسیر ساده شروع کنید. هزینه با آبنبات‌ها قبل از ثبت درخواست
          نمایش داده می‌شود.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link href="/create-image">
            <Button size="lg">ساخت کارتون جدید</Button>
          </Link>
          <Link href="/characters">
            <Button variant="secondary" size="lg">مشاهده شخصیت‌ها</Button>
          </Link>
        </div>
      </div>
    </div>
  )
}

"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { HomepageContent } from "@/lib/homepage/types";
import { DEFAULT_TV_RECT } from "@/lib/homepage/hero-layout";
import { useAdminHomepageMedia } from "@/lib/admin/homepage/use-admin-homepage-media";
import { HomepageEditor } from "@/components/admin/homepage/homepage-editor";
import { MediaSlotCard } from "@/components/admin/homepage/media-slot-card";
import { HeroMediaPanel } from "@/components/admin/homepage/hero-media-panel";
import type { HomepageMediaSlot } from "@/lib/homepage/media-slots";

interface HomepageAdminTabsProps {
  initialContent: HomepageContent;
  initialRevision: number | null;
  isDefault: boolean;
}

const TABS = [
  { id: "hero", label: "هیرو" },
  { id: "sections", label: "پس‌زمینه بخش‌ها" },
  { id: "build", label: "گزینه‌های ساخت" },
  { id: "safety", label: "ایمنی" },
  { id: "copy", label: "متن‌ها" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * /admin/homepage tab container. Media controls live inside the relevant
 * section tab; the Phase-2 copy editor is untouched under «متن‌ها».
 * Tabs wrap without horizontal overflow down to 375px.
 */
export function HomepageAdminTabs({ initialContent, initialRevision, isDefault }: HomepageAdminTabsProps) {
  const [tab, setTab] = useState<TabId>("hero");
  const { overview, loading, error, busy, refresh, uploadSlot, revertSlot, saveLayout } =
    useAdminHomepageMedia();

  const viewOf = (slot: HomepageMediaSlot) =>
    overview?.slots.find((s) => s.slotKey === slot) ?? null;

  async function handleUpload(slot: HomepageMediaSlot, file: File, extra: Record<string, string>) {
    const outcome = await uploadSlot(slot, file, extra);
    if (outcome.kind === "saved") return { ok: true as const };
    return { ok: false as const, message: outcome.message };
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap gap-1 rounded-2xl border border-soft-border bg-white p-1.5" role="tablist" aria-label="بخش‌های صفحه اصلی">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`min-w-0 flex-1 rounded-xl px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parent-navy ${
              tab === t.id ? "bg-parent-navy text-white" : "text-text-dark/70 hover:bg-cream"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "copy" && (
        <div className="mb-6">
          {loading && (
            <div className="space-y-3" aria-label="در حال بارگذاری رسانه">
              {[0, 1].map((i) => (
                <div key={i} className="h-48 animate-pulse rounded-xl border border-soft-border bg-white" />
              ))}
            </div>
          )}
          {error && !loading && (
            <Card variant="admin" className="border-coral/20 bg-coral/5">
              <p className="text-sm text-coral" role="alert">{error}</p>
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={refresh}>تلاش دوباره</Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {!loading && !error && overview && tab === "hero" && (
        <HeroMediaPanel
          heroBg={viewOf("hero.background")}
          tvVideo={viewOf("hero.tv_video")}
          sharedBackground={overview.sharedBackground}
          layoutRect={overview.heroLayout?.rect ?? DEFAULT_TV_RECT}
          layoutRevision={overview.heroLayout?.revision ?? null}
          busy={busy}
          onUpload={async (slot, file, extra) => uploadSlot(slot, file, extra)}
          onRevert={revertSlot}
          onSaveLayout={async (rect, expectedRevision) => {
            const outcome = await saveLayout(rect, expectedRevision);
            return outcome.kind === "saved"
              ? { kind: "saved" as const }
              : { kind: outcome.kind as "conflict" | "invalid" | "error", message: outcome.message };
          }}
        />
      )}

      {!loading && !error && overview && tab === "sections" && (
        <div className="space-y-6">
          <MediaSlotCard
            slot="sections.background"
            view={viewOf("sections.background")}
            busy={busy}
            warning={
              <div className="space-y-1 rounded-xl border border-candy-pink/30 bg-candy-pink/5 p-3">
                <p className="text-xs text-text-dark">
                  این تصویر در پس‌زمینه بخش‌های اصلی صفحه استفاده می‌شود و ممکن است بر هماهنگی بصری اسکرول اثر بگذارد.
                </p>
                <p className="text-xs text-text-dark/60">
                  راهنمای برش فعلی: موتور اجرا بخش پایینی تصویر (حدود ۶۳٪ پایینی) را برجسته می‌کند؛ محتوای کلیدی را در نیمه پایینی نگه دارید.
                </p>
              </div>
            }
            requireConfirm={{
              label: "پیش‌نمایش را دیدم و تأیید می‌کنم.",
              hint: "فرض نکنید تصویر جدید با برش فعلی درست دیده می‌شود.",
            }}
            onUpload={handleUpload}
            onRevert={revertSlot}
          />
        </div>
      )}

      {!loading && !error && overview && tab === "build" && (
        <div className="space-y-6">
          <MediaSlotCard slot="build_options.card_image" view={viewOf("build_options.card_image")} busy={busy} onUpload={handleUpload} onRevert={revertSlot} />
          <MediaSlotCard slot="build_options.card_video" view={viewOf("build_options.card_video")} busy={busy} onUpload={handleUpload} onRevert={revertSlot} />
          <MediaSlotCard slot="build_options.card_animation" view={viewOf("build_options.card_animation")} busy={busy} onUpload={handleUpload} onRevert={revertSlot} />
        </div>
      )}

      {!loading && !error && overview && tab === "safety" && (
        <div className="space-y-6">
          <MediaSlotCard
            slot="safety.image"
            view={viewOf("safety.image")}
            busy={busy}
            warning={<p className="text-xs text-text-dark/60">متن جایگزین تصویر در ویرایشگر متن‌ها (زبانه «متن‌ها») مدیریت می‌شود، نه در فراداده رسانه.</p>}
            onUpload={handleUpload}
            onRevert={revertSlot}
          />
        </div>
      )}

      {tab === "copy" && (
        <HomepageEditor
          initialContent={initialContent}
          initialRevision={initialRevision}
          isDefault={isDefault}
        />
      )}
    </div>
  );
}

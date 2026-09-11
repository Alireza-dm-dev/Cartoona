"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HomepageMediaSlot } from "@/lib/homepage/media-slots";
import type { HeroTvRect } from "@/lib/homepage/hero-layout";
import type { AdminMediaOverview } from "@/lib/admin/homepage/media-service";
import {
  interpretLayoutSaveResponse,
  interpretMediaUploadResponse,
  type LayoutSaveOutcome,
  type MediaSaveOutcome,
} from "@/lib/admin/homepage/media-editor-state";

/**
 * Client data hook for the admin media manager. All server contact goes
 * through the admin API routes (fetch) — never Supabase directly.
 */
export function useAdminHomepageMedia() {
  const [overview, setOverview] = useState<AdminMediaOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Loader lives behind a ref (same pattern as use-admin-coupons) so the
  // mount effect below only invokes it without synchronous setState calls.
  const loadRef = useRef(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/homepage/media", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !Array.isArray(body.slots)) {
        setError("دریافت اطلاعات رسانه انجام نشد.");
        return;
      }
      setOverview(body as AdminMediaOverview);
    } catch {
      setError("خطا در ارتباط با سرور.");
    } finally {
      setLoading(false);
    }
  });

  const refresh = useCallback(() => loadRef.current(), []);

  useEffect(() => {
    loadRef.current();
  }, []);

  async function uploadSlot(
    slot: HomepageMediaSlot,
    file: File,
    extra: Record<string, string>,
  ): Promise<MediaSaveOutcome> {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      for (const [k, v] of Object.entries(extra)) form.append(k, v);
      const res = await fetch(`/api/admin/homepage/media/${encodeURIComponent(slot)}`, {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const outcome = interpretMediaUploadResponse(res.status, body);
      if (outcome.kind === "saved") await refresh();
      return outcome;
    } catch {
      return { kind: "error", message: "خطا در ارتباط با سرور." };
    } finally {
      setBusy(false);
    }
  }

  async function revertSlot(slot: HomepageMediaSlot): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/homepage/media/${encodeURIComponent(slot)}`, {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        return {
          ok: false,
          message: typeof body?.error === "string" ? body.error : "بازگشت به فایل پیش‌فرض انجام نشد.",
        };
      }
      await refresh();
      return { ok: true };
    } catch {
      return { ok: false, message: "خطا در ارتباط با سرور." };
    } finally {
      setBusy(false);
    }
  }

  async function saveLayout(rect: HeroTvRect, expectedRevision: number): Promise<LayoutSaveOutcome> {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/homepage/hero-layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rect, expectedRevision }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const outcome = interpretLayoutSaveResponse(res.status, body);
      if (outcome.kind === "saved") await refresh();
      return outcome;
    } catch {
      return { kind: "error", message: "خطا در ارتباط با سرور." };
    } finally {
      setBusy(false);
    }
  }

  return { overview, loading, error, busy, refresh, uploadSlot, revertSlot, saveLayout };
}

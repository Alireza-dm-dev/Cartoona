"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  BUILD_OPTION_BADGE_VARIANTS,
  BUILD_OPTION_MEDIA_KEYS,
  type BuildOptionBadgeVariant,
  type BuildOptionMediaKey,
  type HomepageContent,
  type HomepageCta,
} from "@/lib/homepage/types";
import { validateHomepageContent } from "@/lib/homepage/validation";
import {
  applyConflictSnapshot,
  cloneHomepageContent,
  interpretHomepageSaveResponse,
  isHomepageDirty,
  toFieldErrorMap,
  type FieldErrorMap,
} from "@/lib/admin/homepage/editor-state";
import { plans } from "@/config/plans";

interface HomepageEditorProps {
  initialContent: HomepageContent;
  initialRevision: number | null;
  isDefault: boolean;
}

const inputClass =
  "w-full rounded-xl border border-soft-border bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-candy-pink/50 focus:ring-2 focus:ring-candy-pink/10 disabled:opacity-50";
const inputErrorClass =
  "w-full rounded-xl border border-coral/50 bg-white px-4 py-2.5 text-sm text-text-dark outline-none focus:border-coral focus:ring-2 focus:ring-coral/10 disabled:opacity-50";
const labelClass = "block text-sm font-medium text-text-dark";
const hintClass = "text-xs text-text-dark/50";
const errorClass = "text-xs text-coral";

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  maxLength,
  multiline,
  ltr,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  maxLength?: number;
  multiline?: boolean;
  ltr?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          maxLength={maxLength}
          disabled={disabled}
          className={error ? inputErrorClass : inputClass}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          disabled={disabled}
          dir={ltr ? "ltr" : undefined}
          className={error ? inputErrorClass : inputClass}
        />
      )}
      {hint && <p className={hintClass}>{hint}</p>}
      {error && (
        <p className={errorClass} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CtaFields({
  legend,
  idPrefix,
  value,
  onChange,
  errors,
  disabled,
}: {
  legend: string;
  idPrefix: string;
  value: HomepageCta;
  onChange: (v: HomepageCta) => void;
  errors: FieldErrorMap;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-soft-border/60 bg-cream/40 p-4">
      <legend className="px-1 text-xs font-semibold text-text-dark/70">{legend}</legend>
      <TextField
        id={`${idPrefix}.label`}
        label="متن دکمه"
        value={value.label}
        onChange={(label) => onChange({ ...value, label })}
        error={errors[`${idPrefix}.label`]}
        maxLength={60}
        disabled={disabled}
      />
      <TextField
        id={`${idPrefix}.href`}
        label="مقصد (مسیر داخلی یا لنگر)"
        value={value.href}
        onChange={(href) => onChange({ ...value, href })}
        error={errors[`${idPrefix}.href`]}
        maxLength={300}
        ltr
        hint="فقط مسیر داخلی (‎/examples‎) یا لنگر (‎#creation-types‎). پیوند خارجی مجاز نیست."
        disabled={disabled}
      />
    </fieldset>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card variant="admin" className="space-y-5">
      <div className="border-b border-soft-border pb-3">
        <h2 className="text-base font-bold text-parent-navy">{title}</h2>
        {description && <p className="mt-1 text-xs text-text-dark/60">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

function slugId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function HomepageEditor({ initialContent, initialRevision, isDefault }: HomepageEditorProps) {
  const [draft, setDraft] = useState<HomepageContent>(() => cloneHomepageContent(initialContent));
  const [baseline, setBaseline] = useState<HomepageContent>(() => cloneHomepageContent(initialContent));
  const [revision, setRevision] = useState<number | null>(initialRevision);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [conflict, setConflict] = useState<{ content: HomepageContent; revision: number } | null>(null);

  const tablesAvailable = revision !== null;
  const dirty = useMemo(() => isHomepageDirty(draft, baseline), [draft, baseline]);

  const fieldErrors: FieldErrorMap = useMemo(() => {
    const result = validateHomepageContent(draft);
    return result.ok ? {} : toFieldErrorMap(result.errors);
  }, [draft]);

  const hasBlockingErrors = Object.keys(fieldErrors).length > 0;

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function patch<K extends keyof HomepageContent>(section: K, value: HomepageContent[K]) {
    setDraft((prev) => ({ ...prev, [section]: value }));
    setMessage(null);
  }

  async function handleSave() {
    if (!tablesAvailable || saving || hasBlockingErrors) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/homepage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft, expectedRevision: revision }),
      });
      const body = await res.json().catch(() => ({}));
      const outcome = interpretHomepageSaveResponse(res.status, body);
      if (outcome.kind === "saved") {
        const fresh = cloneHomepageContent(outcome.content);
        setDraft(fresh);
        setBaseline(cloneHomepageContent(fresh));
        setRevision(outcome.revision);
        setConflict(null);
        setMessage({ kind: "success", text: `تغییرات ذخیره شد (نسخه ${outcome.revision}).` });
      } else if (outcome.kind === "conflict") {
        setConflict({ content: outcome.content, revision: outcome.revision });
        setMessage({ kind: "error", text: outcome.message });
      } else {
        setMessage({ kind: "error", text: outcome.message });
      }
    } catch {
      setMessage({ kind: "error", text: "خطا در ارتباط با سرور. دوباره تلاش کنید." });
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setDraft(cloneHomepageContent(baseline));
    setConflict(null);
    setMessage(null);
  }

  function handleReloadConflict() {
    if (!conflict) return;
    const applied = applyConflictSnapshot(conflict.content);
    setDraft(applied.draft);
    setBaseline(applied.baseline);
    setRevision(conflict.revision);
    setConflict(null);
    setMessage({
      kind: "success",
      text: `نسخه جدید (‎${conflict.revision}‎) بارگذاری شد. تغییرات خود را دوباره اعمال کنید.`,
    });
  }

  async function handleReload() {
    setMessage(null);
    try {
      const res = await fetch("/api/admin/homepage", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body?.content !== "object" || body.content === null) {
        setMessage({ kind: "error", text: "بارگذاری مجدد انجام نشد." });
        return;
      }
      const validated = validateHomepageContent(body.content);
      if (!validated.ok) {
        setMessage({ kind: "error", text: "محتوای سرور معتبر نیست." });
        return;
      }
      const fresh = cloneHomepageContent(validated.content);
      setDraft(fresh);
      setBaseline(cloneHomepageContent(fresh));
      setRevision(typeof body.revision === "number" ? body.revision : null);
      setConflict(null);
      setMessage({ kind: "success", text: "آخرین نسخه از سرور بارگذاری شد." });
    } catch {
      setMessage({ kind: "error", text: "خطا در ارتباط با سرور." });
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="ویرایش صفحه اصلی"
        description="متن‌ها و محتوای صفحه اصلی را ویرایش کنید. چیدمان، هندسه هیرو و رفتار صفحه در کد می‌ماند."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleReload} disabled={saving}>
              بارگذاری مجدد
            </Button>
            <Button variant="secondary" onClick={handleReset} disabled={!dirty || saving}>
              بازگردانی
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!dirty || saving || hasBlockingErrors || !tablesAvailable}>
              {saving ? "در حال ذخیره…" : "ذخیره تغییرات"}
            </Button>
          </div>
        }
      />

      {isDefault && (
        <Card variant="admin" className="mb-6 border-candy-pink/30 bg-candy-pink/5">
          <p className="text-sm text-text-dark" role="status">
            جدول‌های CMS هنوز در دسترس نیستند؛ ویرایشگر با محتوای پیش‌فرض باز شده و ذخیره غیرفعال است.
            اعمال مهاجرت‌های معلق روی پایگاه‌داده، مرحله استقرار جداگانه است.
          </p>
        </Card>
      )}

      {!isDefault && revision !== null && (
        <p className="mb-6 text-xs text-text-dark/50" role="status">
          نسخه فعلی: {revision}
          {dirty && " · تغییرات ذخیره‌نشده دارید"}
        </p>
      )}

      {message && (
        <Card
          variant="admin"
          className={`mb-6 ${message.kind === "success" ? "border-mint/30 bg-mint/5" : "border-coral/20 bg-coral/5"}`}
        >
          <p className={`text-sm ${message.kind === "success" ? "text-text-dark" : "text-coral"}`} role="alert">
            {message.text}
          </p>
        </Card>
      )}

      {conflict && (
        <Card variant="admin" className="mb-6 border-coral/20 bg-coral/5">
          <p className="text-sm text-text-dark" role="alert">
            مدیر دیگری این صفحه را تغییر داده است (نسخه {conflict.revision}). برای ادامه، نسخه جدید را
            بارگذاری کنید و تغییرات خود را دوباره اعمال کنید.
          </p>
          <div className="mt-3">
            <Button variant="primary" onClick={handleReloadConflict}>
              بارگذاری نسخه جدید
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-6">
        {/* ── Hero ── */}
        <SectionCard title="هیرو" description="متن بالای صفحه اصلی. هندسه و تصویر هیرو در کد می‌ماند.">
          <TextField id="hero.eyebrow" label="ابرعنوان" value={draft.hero.eyebrow}
            onChange={(eyebrow) => patch("hero", { ...draft.hero, eyebrow })}
            error={fieldErrors["hero.eyebrow"]} maxLength={120} disabled={!tablesAvailable} />
          <TextField id="hero.title" label="عنوان" value={draft.hero.title}
            onChange={(title) => patch("hero", { ...draft.hero, title })}
            error={fieldErrors["hero.title"]} maxLength={160} disabled={!tablesAvailable} />
          <TextField id="hero.description" label="توضیح" value={draft.hero.description} multiline
            onChange={(description) => patch("hero", { ...draft.hero, description })}
            error={fieldErrors["hero.description"]} maxLength={600} disabled={!tablesAvailable} />
          <CtaFields legend="دکمه اصلی" idPrefix="hero.primaryCta" value={draft.hero.primaryCta}
            onChange={(primaryCta) => patch("hero", { ...draft.hero, primaryCta })}
            errors={fieldErrors} disabled={!tablesAvailable} />
          <CtaFields legend="دکمه دوم" idPrefix="hero.secondaryCta" value={draft.hero.secondaryCta}
            onChange={(secondaryCta) => patch("hero", { ...draft.hero, secondaryCta })}
            errors={fieldErrors} disabled={!tablesAvailable} />
          <TextField id="hero.trustLine" label="خط اعتماد" value={draft.hero.trustLine}
            onChange={(trustLine) => patch("hero", { ...draft.hero, trustLine })}
            error={fieldErrors["hero.trustLine"]} maxLength={200} disabled={!tablesAvailable} />
        </SectionCard>

        {/* ── Build options ── */}
        <SectionCard title="گزینه‌های ساخت" description="کارت‌ها ثابت‌اند؛ فقط متن، نشان و مقصد قابل ویرایش است.">
          <TextField id="buildOptions.title" label="عنوان بخش" value={draft.buildOptions.title}
            onChange={(title) => patch("buildOptions", { ...draft.buildOptions, title })}
            error={fieldErrors["buildOptions.title"]} maxLength={160} disabled={!tablesAvailable} />
          <TextField id="buildOptions.description" label="توضیح بخش" value={draft.buildOptions.description} multiline
            onChange={(description) => patch("buildOptions", { ...draft.buildOptions, description })}
            error={fieldErrors["buildOptions.description"]} maxLength={600} disabled={!tablesAvailable} />
          {draft.buildOptions.cards.map((card, i) => {
            const f = `buildOptions.cards[${i}]`;
            return (
              <fieldset key={card.id} className="space-y-3 rounded-xl border border-soft-border/60 bg-white p-4">
                <legend className="px-1 text-xs font-semibold text-text-dark/70">کارت {i + 1} ‏(شناسه: {card.id})</legend>
                <TextField id={`${f}.badge`} label="نشان" value={card.badge}
                  onChange={(badge) => patch("buildOptions", {
                    ...draft.buildOptions,
                    cards: draft.buildOptions.cards.map((c) => (c.id === card.id ? { ...c, badge } : c)),
                  })}
                  error={fieldErrors[`${f}.badge`]} maxLength={40} disabled={!tablesAvailable} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor={`${f}.badgeVariant`} className={labelClass}>سبک نشان</label>
                    <select id={`${f}.badgeVariant`} value={card.badgeVariant} disabled={!tablesAvailable}
                      onChange={(e) => patch("buildOptions", {
                        ...draft.buildOptions,
                        cards: draft.buildOptions.cards.map((c) =>
                          c.id === card.id ? { ...c, badgeVariant: e.target.value as BuildOptionBadgeVariant } : c),
                      })}
                      className={inputClass}>
                      {BUILD_OPTION_BADGE_VARIANTS.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    {fieldErrors[`${f}.badgeVariant`] && (
                      <p className={errorClass} role="alert">{fieldErrors[`${f}.badgeVariant`]}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`${f}.media`} className={labelClass}>رسانه کارت</label>
                    <select id={`${f}.media`} value={card.media} disabled={!tablesAvailable}
                      onChange={(e) => patch("buildOptions", {
                        ...draft.buildOptions,
                        cards: draft.buildOptions.cards.map((c) =>
                          c.id === card.id ? { ...c, media: e.target.value as BuildOptionMediaKey } : c),
                      })}
                      className={inputClass}>
                      {BUILD_OPTION_MEDIA_KEYS.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    {fieldErrors[`${f}.media`] && (
                      <p className={errorClass} role="alert">{fieldErrors[`${f}.media`]}</p>
                    )}
                  </div>
                </div>
                <TextField id={`${f}.title`} label="عنوان کارت" value={card.title}
                  onChange={(title) => patch("buildOptions", {
                    ...draft.buildOptions,
                    cards: draft.buildOptions.cards.map((c) => (c.id === card.id ? { ...c, title } : c)),
                  })}
                  error={fieldErrors[`${f}.title`]} maxLength={120} disabled={!tablesAvailable} />
                <TextField id={`${f}.description`} label="توضیح کارت" value={card.description} multiline
                  onChange={(description) => patch("buildOptions", {
                    ...draft.buildOptions,
                    cards: draft.buildOptions.cards.map((c) => (c.id === card.id ? { ...c, description } : c)),
                  })}
                  error={fieldErrors[`${f}.description`]} maxLength={400} disabled={!tablesAvailable} />
                <CtaFields legend="دکمه کارت" idPrefix={`${f}.cta`} value={card.cta}
                  onChange={(cta) => patch("buildOptions", {
                    ...draft.buildOptions,
                    cards: draft.buildOptions.cards.map((c) => (c.id === card.id ? { ...c, cta } : c)),
                  })}
                  errors={fieldErrors} disabled={!tablesAvailable} />
              </fieldset>
            );
          })}
          <TextField id="buildOptions.footnote" label="پانوشت" value={draft.buildOptions.footnote} multiline
            onChange={(footnote) => patch("buildOptions", { ...draft.buildOptions, footnote })}
            error={fieldErrors["buildOptions.footnote"]} maxLength={400} disabled={!tablesAvailable} />
        </SectionCard>

        {/* ── Characters ── */}
        <SectionCard title="شخصیت‌ها" description="کارت‌های شخصیت ثابت‌اند؛ فقط متن قابل ویرایش است.">
          <TextField id="characters.eyebrow" label="ابرعنوان" value={draft.characters.eyebrow}
            onChange={(eyebrow) => patch("characters", { ...draft.characters, eyebrow })}
            error={fieldErrors["characters.eyebrow"]} maxLength={120} disabled={!tablesAvailable} />
          <TextField id="characters.title" label="عنوان" value={draft.characters.title}
            onChange={(title) => patch("characters", { ...draft.characters, title })}
            error={fieldErrors["characters.title"]} maxLength={160} disabled={!tablesAvailable} />
          <TextField id="characters.description" label="توضیح" value={draft.characters.description} multiline
            onChange={(description) => patch("characters", { ...draft.characters, description })}
            error={fieldErrors["characters.description"]} maxLength={600} disabled={!tablesAvailable} />
          {draft.characters.cards.map((card, i) => {
            const f = `characters.cards[${i}]`;
            return (
              <fieldset key={card.id} className="space-y-3 rounded-xl border border-soft-border/60 bg-white p-4">
                <legend className="px-1 text-xs font-semibold text-text-dark/70">شخصیت {i + 1} ‏(شناسه: {card.id})</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField id={`${f}.emoji`} label="ایموجی" value={card.emoji}
                    onChange={(emoji) => patch("characters", {
                      ...draft.characters,
                      cards: draft.characters.cards.map((c) => (c.id === card.id ? { ...c, emoji } : c)),
                    })}
                    error={fieldErrors[`${f}.emoji`]} maxLength={8} disabled={!tablesAvailable} />
                  <TextField id={`${f}.name`} label="نام" value={card.name}
                    onChange={(name) => patch("characters", {
                      ...draft.characters,
                      cards: draft.characters.cards.map((c) => (c.id === card.id ? { ...c, name } : c)),
                    })}
                    error={fieldErrors[`${f}.name`]} maxLength={80} disabled={!tablesAvailable} />
                  <TextField id={`${f}.age`} label="رده سنی" value={card.age}
                    onChange={(age) => patch("characters", {
                      ...draft.characters,
                      cards: draft.characters.cards.map((c) => (c.id === card.id ? { ...c, age } : c)),
                    })}
                    error={fieldErrors[`${f}.age`]} maxLength={40} disabled={!tablesAvailable} />
                </div>
                <TextField id={`${f}.description`} label="توضیح" value={card.description} multiline
                  onChange={(description) => patch("characters", {
                    ...draft.characters,
                    cards: draft.characters.cards.map((c) => (c.id === card.id ? { ...c, description } : c)),
                  })}
                  error={fieldErrors[`${f}.description`]} maxLength={400} disabled={!tablesAvailable} />
              </fieldset>
            );
          })}
          <CtaFields legend="دکمه بخش" idPrefix="characters.cta" value={draft.characters.cta}
            onChange={(cta) => patch("characters", { ...draft.characters, cta })}
            errors={fieldErrors} disabled={!tablesAvailable} />
        </SectionCard>

        {/* ── Safety ── */}
        <SectionCard title="ایمنی" description="متن بخش ایمنی. تصویر بخش در فاز رسانه مدیریت می‌شود.">
          <TextField id="safety.eyebrow" label="ابرعنوان" value={draft.safety.eyebrow}
            onChange={(eyebrow) => patch("safety", { ...draft.safety, eyebrow })}
            error={fieldErrors["safety.eyebrow"]} maxLength={120} disabled={!tablesAvailable} />
          <TextField id="safety.title" label="عنوان" value={draft.safety.title}
            onChange={(title) => patch("safety", { ...draft.safety, title })}
            error={fieldErrors["safety.title"]} maxLength={160} disabled={!tablesAvailable} />
          <TextField id="safety.description" label="توضیح" value={draft.safety.description} multiline
            onChange={(description) => patch("safety", { ...draft.safety, description })}
            error={fieldErrors["safety.description"]} maxLength={600} disabled={!tablesAvailable} />
          {draft.safety.points.map((point, i) => {
            const f = `safety.points[${i}]`;
            return (
              <fieldset key={point.id} className="space-y-3 rounded-xl border border-soft-border/60 bg-white p-4">
                <legend className="px-1 text-xs font-semibold text-text-dark/70">نکته {i + 1} ‏(شناسه: {point.id})</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField id={`${f}.mark`} label="نشان" value={point.mark}
                    onChange={(mark) => patch("safety", {
                      ...draft.safety,
                      points: draft.safety.points.map((p) => (p.id === point.id ? { ...p, mark } : p)),
                    })}
                    error={fieldErrors[`${f}.mark`]} maxLength={8} disabled={!tablesAvailable} />
                  <div className="sm:col-span-2">
                    <TextField id={`${f}.title`} label="عنوان" value={point.title}
                      onChange={(title) => patch("safety", {
                        ...draft.safety,
                        points: draft.safety.points.map((p) => (p.id === point.id ? { ...p, title } : p)),
                      })}
                      error={fieldErrors[`${f}.title`]} maxLength={120} disabled={!tablesAvailable} />
                  </div>
                </div>
                <TextField id={`${f}.description`} label="توضیح" value={point.description} multiline
                  onChange={(description) => patch("safety", {
                    ...draft.safety,
                    points: draft.safety.points.map((p) => (p.id === point.id ? { ...p, description } : p)),
                  })}
                  error={fieldErrors[`${f}.description`]} maxLength={400} disabled={!tablesAvailable} />
              </fieldset>
            );
          })}
          <TextField id="safety.imageAlt" label="متن جایگزین تصویر" value={draft.safety.imageAlt}
            onChange={(imageAlt) => patch("safety", { ...draft.safety, imageAlt })}
            error={fieldErrors["safety.imageAlt"]} maxLength={200} disabled={!tablesAvailable} />
          <TextField id="safety.note" label="یادداشت" value={draft.safety.note} multiline
            onChange={(note) => patch("safety", { ...draft.safety, note })}
            error={fieldErrors["safety.note"]} maxLength={300} disabled={!tablesAvailable} />
        </SectionCard>

        {/* ── Pricing ── */}
        <SectionCard title="قیمت‌گذاری" description="فقط انتخاب پلن‌های نمایشی. نام، قیمت و آب‌نبات پلن‌ها در پیکربندی کد می‌ماند.">
          <TextField id="pricing.eyebrow" label="ابرعنوان" value={draft.pricing.eyebrow}
            onChange={(eyebrow) => patch("pricing", { ...draft.pricing, eyebrow })}
            error={fieldErrors["pricing.eyebrow"]} maxLength={120} disabled={!tablesAvailable} />
          <TextField id="pricing.title" label="عنوان" value={draft.pricing.title}
            onChange={(title) => patch("pricing", { ...draft.pricing, title })}
            error={fieldErrors["pricing.title"]} maxLength={160} disabled={!tablesAvailable} />
          <fieldset className="space-y-2 rounded-xl border border-soft-border/60 bg-white p-4">
            <legend className="px-1 text-xs font-semibold text-text-dark/70">پلن‌های نمایشی</legend>
            {plans.map((plan) => {
              const checked = draft.pricing.featuredPlanIds.includes(plan.id);
              return (
                <label key={plan.id} className="flex items-center gap-2 text-sm text-text-dark">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!tablesAvailable}
                    onChange={(e) => {
                      const featuredPlanIds = e.target.checked
                        ? [...draft.pricing.featuredPlanIds, plan.id]
                        : draft.pricing.featuredPlanIds.filter((id) => id !== plan.id);
                      patch("pricing", { ...draft.pricing, featuredPlanIds });
                    }}
                    className="h-4 w-4 rounded border-soft-border"
                  />
                  {plan.name} <span className="text-xs text-text-dark/50">({plan.id})</span>
                </label>
              );
            })}
            {fieldErrors["pricing.featuredPlanIds"] && (
              <p className={errorClass} role="alert">{fieldErrors["pricing.featuredPlanIds"]}</p>
            )}
          </fieldset>
          <TextField id="pricing.linkLabel" label="متن پیوند" value={draft.pricing.linkLabel}
            onChange={(linkLabel) => patch("pricing", { ...draft.pricing, linkLabel })}
            error={fieldErrors["pricing.linkLabel"]} maxLength={60} disabled={!tablesAvailable} />
          <TextField id="pricing.linkHref" label="مقصد پیوند" value={draft.pricing.linkHref} ltr
            onChange={(linkHref) => patch("pricing", { ...draft.pricing, linkHref })}
            error={fieldErrors["pricing.linkHref"]} maxLength={300}
            hint="فقط مسیر داخلی (‎/pricing‎)." disabled={!tablesAvailable} />
          <TextField id="pricing.footnote" label="پانوشت" value={draft.pricing.footnote} multiline
            onChange={(footnote) => patch("pricing", { ...draft.pricing, footnote })}
            error={fieldErrors["pricing.footnote"]} maxLength={400} disabled={!tablesAvailable} />
        </SectionCard>

        {/* ── Testimonials ── */}
        <SectionCard title="نظرات والدین" description="می‌توانید نظر اضافه یا حذف کنید (حداکثر ۸ نظر).">
          <TextField id="testimonials.title" label="عنوان بخش" value={draft.testimonials.title}
            onChange={(title) => patch("testimonials", { ...draft.testimonials, title })}
            error={fieldErrors["testimonials.title"]} maxLength={160} disabled={!tablesAvailable} />
          {draft.testimonials.items.map((item, i) => {
            const f = `testimonials.items[${i}]`;
            return (
              <fieldset key={item.id} className="space-y-3 rounded-xl border border-soft-border/60 bg-white p-4">
                <legend className="px-1 text-xs font-semibold text-text-dark/70">نظر {i + 1}</legend>
                <TextField id={`${f}.quote`} label="متن نظر" value={item.quote} multiline
                  onChange={(quote) => patch("testimonials", {
                    ...draft.testimonials,
                    items: draft.testimonials.items.map((t) => (t.id === item.id ? { ...t, quote } : t)),
                  })}
                  error={fieldErrors[`${f}.quote`]} maxLength={600} disabled={!tablesAvailable} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField id={`${f}.name`} label="نام" value={item.name}
                    onChange={(name) => patch("testimonials", {
                      ...draft.testimonials,
                      items: draft.testimonials.items.map((t) => (t.id === item.id ? { ...t, name } : t)),
                    })}
                    error={fieldErrors[`${f}.name`]} maxLength={80} disabled={!tablesAvailable} />
                  <TextField id={`${f}.role`} label="نقش" value={item.role}
                    onChange={(role) => patch("testimonials", {
                      ...draft.testimonials,
                      items: draft.testimonials.items.map((t) => (t.id === item.id ? { ...t, role } : t)),
                    })}
                    error={fieldErrors[`${f}.role`]} maxLength={120} disabled={!tablesAvailable} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!tablesAvailable || draft.testimonials.items.length <= 1}
                  onClick={() => patch("testimonials", {
                    ...draft.testimonials,
                    items: draft.testimonials.items.filter((t) => t.id !== item.id),
                  })}
                >
                  حذف این نظر
                </Button>
              </fieldset>
            );
          })}
          <Button
            variant="secondary"
            size="sm"
            disabled={!tablesAvailable || draft.testimonials.items.length >= 8}
            onClick={() => patch("testimonials", {
              ...draft.testimonials,
              items: [...draft.testimonials.items, { id: slugId("t"), quote: "", name: "", role: "" }],
            })}
          >
            افزودن نظر
          </Button>
        </SectionCard>

        {/* ── FAQ teaser ── */}
        <SectionCard title="پیش‌نمایش سوالات متداول" description="فقط انتخاب پرسش‌ها. متن پاسخ‌ها در پیکربندی کد می‌ماند.">
          <TextField id="faqTeaser.eyebrow" label="ابرعنوان" value={draft.faqTeaser.eyebrow}
            onChange={(eyebrow) => patch("faqTeaser", { ...draft.faqTeaser, eyebrow })}
            error={fieldErrors["faqTeaser.eyebrow"]} maxLength={120} disabled={!tablesAvailable} />
          <TextField id="faqTeaser.title" label="عنوان" value={draft.faqTeaser.title}
            onChange={(title) => patch("faqTeaser", { ...draft.faqTeaser, title })}
            error={fieldErrors["faqTeaser.title"]} maxLength={160} disabled={!tablesAvailable} />
          {draft.faqTeaser.questions.map((question, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1">
                <TextField id={`faqTeaser.questions[${i}]`} label={`پرسش ${i + 1}`} value={question}
                  onChange={(v) => patch("faqTeaser", {
                    ...draft.faqTeaser,
                    questions: draft.faqTeaser.questions.map((q, qi) => (qi === i ? v : q)),
                  })}
                  error={fieldErrors[`faqTeaser.questions[${i}]`]} maxLength={300} disabled={!tablesAvailable} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!tablesAvailable || draft.faqTeaser.questions.length <= 1}
                onClick={() => patch("faqTeaser", {
                  ...draft.faqTeaser,
                  questions: draft.faqTeaser.questions.filter((_, qi) => qi !== i),
                })}
                className="mt-7"
              >
                حذف
              </Button>
            </div>
          ))}
          {fieldErrors["faqTeaser.questions"] && (
            <p className={errorClass} role="alert">{fieldErrors["faqTeaser.questions"]}</p>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!tablesAvailable || draft.faqTeaser.questions.length >= 6}
            onClick={() => patch("faqTeaser", {
              ...draft.faqTeaser,
              questions: [...draft.faqTeaser.questions, ""],
            })}
          >
            افزودن پرسش
          </Button>
          <TextField id="faqTeaser.linkLabel" label="متن پیوند" value={draft.faqTeaser.linkLabel}
            onChange={(linkLabel) => patch("faqTeaser", { ...draft.faqTeaser, linkLabel })}
            error={fieldErrors["faqTeaser.linkLabel"]} maxLength={60} disabled={!tablesAvailable} />
          <TextField id="faqTeaser.linkHref" label="مقصد پیوند" value={draft.faqTeaser.linkHref} ltr
            onChange={(linkHref) => patch("faqTeaser", { ...draft.faqTeaser, linkHref })}
            error={fieldErrors["faqTeaser.linkHref"]} maxLength={300}
            hint="فقط مسیر داخلی (‎/faq‎)." disabled={!tablesAvailable} />
        </SectionCard>

        {/* ── Final CTA ── */}
        <SectionCard title="دعوت پایانی" description="بخش پایانی صفحه اصلی.">
          <TextField id="finalCta.title" label="عنوان" value={draft.finalCta.title}
            onChange={(title) => patch("finalCta", { ...draft.finalCta, title })}
            error={fieldErrors["finalCta.title"]} maxLength={160} disabled={!tablesAvailable} />
          <TextField id="finalCta.description" label="توضیح" value={draft.finalCta.description} multiline
            onChange={(description) => patch("finalCta", { ...draft.finalCta, description })}
            error={fieldErrors["finalCta.description"]} maxLength={600} disabled={!tablesAvailable} />
          <CtaFields legend="دکمه اصلی" idPrefix="finalCta.primaryCta" value={draft.finalCta.primaryCta}
            onChange={(primaryCta) => patch("finalCta", { ...draft.finalCta, primaryCta })}
            errors={fieldErrors} disabled={!tablesAvailable} />
          <CtaFields legend="دکمه دوم" idPrefix="finalCta.secondaryCta" value={draft.finalCta.secondaryCta}
            onChange={(secondaryCta) => patch("finalCta", { ...draft.finalCta, secondaryCta })}
            errors={fieldErrors} disabled={!tablesAvailable} />
        </SectionCard>
      </div>

      <div className="mt-8 flex flex-wrap gap-2">
        <Button variant="primary" onClick={handleSave} disabled={!dirty || saving || hasBlockingErrors || !tablesAvailable}>
          {saving ? "در حال ذخیره…" : "ذخیره تغییرات"}
        </Button>
        <Button variant="secondary" onClick={handleReset} disabled={!dirty || saving}>
          بازگردانی
        </Button>
        <Button variant="secondary" onClick={handleReload} disabled={saving}>
          بارگذاری مجدد
        </Button>
      </div>
    </div>
  );
}

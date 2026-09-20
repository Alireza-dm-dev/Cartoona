/**
 * Curated starting points for the creation forms.
 *
 * These are a writing aid, nothing more. Selecting one writes its `value` into
 * the ordinary text field it sits beside, and that text is the only thing that
 * is ever stored — no preset id is persisted, no column was added, and the
 * submission path cannot tell a preset apart from something the parent typed.
 *
 * Scene and story presets carry a full starter sentence rather than the chip's
 * short label, because a one-word answer is not a useful brief for whoever
 * fulfils the request. The shorter style and occasion fields take the label
 * itself, which is already the value a parent would have written.
 *
 * Labels and values deliberately avoid real-world or licensed character names:
 * the copy refers to "شخصیت انتخاب‌شده", the character the parent picked in
 * step one.
 */
export interface CreationPreset {
  /** Persian text on the chip. */
  label: string;
  /** Text written into the field when the chip is chosen. */
  value: string;
}

/** توضیح صحنه — /create-image */
export const IMAGE_SCENE_PRESETS: readonly CreationPreset[] = [
  {
    label: "کودک در کنار شخصیت محبوبش",
    value: "کودک در کنار شخصیت انتخاب‌شده در یک صحنه شاد و دوستانه قرار داشته باشد.",
  },
  {
    label: "جشن تولد",
    value: "کودک در یک جشن تولد رنگارنگ با کیک، بادکنک و شخصیت انتخاب‌شده در حال شادی باشد.",
  },
  {
    label: "ماجراجویی در جنگل",
    value: "کودک و شخصیت انتخاب‌شده در یک جنگل رنگارنگ و دوستانه در حال کشف و ماجراجویی باشند.",
  },
  {
    label: "دنیای جادویی",
    value: "کودک در یک دنیای جادویی و رنگارنگ با نورهای درخشان و فضای فانتزی قرار داشته باشد.",
  },
  {
    label: "سفر به فضا",
    value: "کودک همراه شخصیت انتخاب‌شده در میان ستاره‌ها و سیاره‌های رنگارنگ در حال سفر باشد.",
  },
  {
    label: "کنار حیوانات",
    value: "کودک در کنار حیوانات مهربان و بامزه در یک فضای سبز و آرام در حال بازی باشد.",
  },
  {
    label: "قهرمان داستان",
    value: "کودک در نقش قهرمان داستان، شجاع و پرانرژی، در یک صحنه هیجان‌انگیز دیده شود.",
  },
  {
    label: "بازی در پارک",
    value: "کودک در یک پارک آفتابی همراه شخصیت انتخاب‌شده مشغول بازی و دویدن باشد.",
  },
  {
    label: "کنار خانواده",
    value: "کودک در کنار خانواده در یک لحظه گرم و صمیمی در خانه دیده شود.",
  },
  {
    label: "جشن و بادکنک",
    value: "کودک در میان بادکنک‌های رنگارنگ و کاغذرنگی‌ها در حال جشن گرفتن باشد.",
  },
];

/** سبک تصویر — /create-image. Short descriptors; the label is the value. */
export const IMAGE_STYLE_PRESETS: readonly CreationPreset[] = [
  "کارتونی سه‌بعدی",
  "کارتونی دوبعدی",
  "آبرنگی",
  "کتاب داستان کودک",
  "فانتزی و جادویی",
  "کمیک",
  "نرم و مینیمال",
  "رنگارنگ و شاد",
  "نقاشی دستی",
  "سینمایی کارتونی",
].map((label) => ({ label, value: label }));

/** مناسبت یا موضوع — /create-image. Optional field; stays optional. */
export const IMAGE_OCCASION_PRESETS: readonly CreationPreset[] = [
  "تولد",
  "نوروز",
  "شب یلدا",
  "مدرسه",
  "خانواده",
  "دوستی",
  "سفر",
  "طبیعت",
  "ورزش",
  "قهرمانانه",
  "بدون موضوع خاص",
].map((label) => ({ label, value: label }));

/** توضیح داستان یا صحنه — /request-video */
export const VIDEO_STORY_PRESETS: readonly CreationPreset[] = [
  {
    label: "جشن تولد کودک",
    value: "کودک در یک جشن تولد شاد با بادکنک‌ها، کیک و شخصیت انتخاب‌شده حضور داشته باشد.",
  },
  {
    label: "ماجراجویی در جنگل",
    value: "کودک و شخصیت انتخاب‌شده در یک جنگل رنگارنگ و دوستانه در حال کشف و ماجراجویی باشند.",
  },
  {
    label: "سفر به فضا",
    value: "کودک همراه شخصیت انتخاب‌شده در یک سفینه فضایی رنگارنگ بین سیاره‌ها ماجراجویی کند.",
  },
  {
    label: "بازی با دوستان",
    value: "کودک همراه دوستانش و شخصیت انتخاب‌شده در یک بازی گروهی شاد سرگرم باشد.",
  },
  {
    label: "نجات یک حیوان",
    value: "کودک و شخصیت انتخاب‌شده با هم یک حیوان کوچک را نجات دهند و از او مراقبت کنند.",
  },
  {
    label: "مسابقه و رقابت دوستانه",
    value: "کودک در یک مسابقه‌ی دوستانه و هیجان‌انگیز همراه شخصیت انتخاب‌شده شرکت کند.",
  },
  {
    label: "جشن در مدرسه",
    value: "کودک در یک جشن شاد مدرسه همراه هم‌کلاسی‌ها و شخصیت انتخاب‌شده حضور داشته باشد.",
  },
  {
    label: "دیدار با شخصیت محبوب",
    value: "کودک برای اولین بار با شخصیت انتخاب‌شده دیدار کند و با هم دوست شوند.",
  },
  {
    label: "ماجراجویی در دنیای جادویی",
    value: "کودک و شخصیت انتخاب‌شده در یک دنیای جادویی پر از نور و رنگ ماجراجویی کنند.",
  },
  {
    label: "داستان خانوادگی شاد",
    value: "کودک در کنار خانواده و شخصیت انتخاب‌شده یک روز گرم و به‌یادماندنی را بگذراند.",
  },
];

/** مناسبت یا پیام ویدیو — /request-video. Optional field; stays optional. */
export const VIDEO_OCCASION_PRESETS: readonly CreationPreset[] = [
  "تولد",
  "تبریک موفقیت",
  "روز کودک",
  "نوروز",
  "شب یلدا",
  "تشویق و انگیزه",
  "دوستت دارم",
  "برای یادگاری",
  "سورپرایز",
  "بدون مناسبت خاص",
].map((label) => ({ label, value: label }));

/**
 * The preset a field's current text came from, or null.
 *
 * Selection is derived from the text rather than tracked separately, which is
 * what keeps the field the single source of truth: editing a generated
 * sentence simply stops matching and quietly deselects the chip, and nothing
 * the parent typed is ever overwritten or lost.
 */
export function matchPreset(
  presets: readonly CreationPreset[],
  value: string,
): CreationPreset | null {
  return presets.find((preset) => preset.value === value) ?? null;
}

import type { HomepageContent } from "@/lib/homepage/types";

/**
 * The currently approved homepage copy, transcribed verbatim from the section
 * components. This is the canonical fallback: it seeds a fresh database, backs
 * the runtime when the CMS row is missing or fails validation, and is what the
 * migration writes into the singleton row.
 *
 * Copy was NOT changed while lifting it here - the rendered homepage is the
 * source of truth. Later phases remove the duplicated literals from the
 * components; until then the components remain the ones actually rendering.
 */
export const DEFAULT_HOMEPAGE_CONTENT: HomepageContent = {
  hero: {
    eyebrow: "استودیوی خصوصی ساخت کارتون برای خانواده‌ها",
    title: "خاطره‌های کارتونی جادویی بسازید",
    description:
      "با کارتونا، والدین می‌توانند برای کودک خود تصویر، ویدئو یا انیمیشن کارتونی اختصاصی سفارش دهند؛ امن، خصوصی و کاملاً تحت کنترل والدین.",
    primaryCta: { label: "شروع ساخت کارتون", href: "#creation-types" },
    secondaryCta: { label: "مشاهده نمونه‌ها", href: "/examples" },
    trustLine: "تحت کنترل والدین · خصوصی برای خانواده · بدون اشتراک‌گذاری عمومی",
  },

  buildOptions: {
    title: "چه چیزی می‌خواهید بسازید؟",
    description:
      "یکی از روش‌های ساخت را انتخاب کنید. جزئیات درخواست را ابتدا وارد می‌کنید و فقط هنگام ثبت نهایی وارد حساب می‌شوید یا حساب می‌سازید.",
    cards: [
      {
        id: "image",
        badge: "تصویر",
        badgeVariant: "default",
        title: "تصویر کارتونی اختصاصی",
        description: "یک تصویر کارتونی شخصی‌سازی‌شده با شخصیت، صحنه و سبک دلخواه بسازید.",
        cta: { label: "شروع ساخت تصویر", href: "/create-image" },
        media: "card_image",
      },
      {
        id: "video",
        badge: "ویدیو",
        badgeVariant: "info",
        title: "ویدیوی کارتونی",
        description: "یک داستان یا پیام کوتاه را به ویدیوی کارتونی شخصی‌سازی‌شده تبدیل کنید.",
        cta: { label: "شروع ساخت ویدیو", href: "/request-video" },
        media: "card_video",
      },
      {
        id: "drawing_animation",
        badge: "نقاشی متحرک",
        badgeVariant: "success",
        title: "متحرک‌سازی نقاشی",
        description: "نقاشی کودک را به یک انیمیشن کوتاه و زنده تبدیل کنید.",
        cta: { label: "شروع متحرک‌سازی", href: "/animate-drawing" },
        media: "card_animation",
      },
    ],
    footnote:
      "می‌توانید ابتدا نوع و جزئیات ساخت را انتخاب کنید؛ ورود یا ساخت حساب فقط هنگام ثبت نهایی درخواست لازم است.",
  },

  characters: {
    eyebrow: "شخصیت‌ها",
    title: "شخصیت‌های دوست‌داشتنی کارتونا",
    description:
      "یکی از شخصیت‌های اصلی را انتخاب کنید یا از روی عکس کودکتان یک شخصیت اختصاصی بسازید. همه‌ی شخصیت‌ها برای سنین کودکی طراحی شده‌اند.",
    cards: [
      {
        id: "mimi",
        emoji: "🐰",
        name: "میمی",
        age: "۳ تا ۶ سال",
        description: "خرگوش کنجکاوی که عاشق قصه‌های شب است.",
      },
      {
        id: "babu",
        emoji: "🤖",
        name: "بابو",
        age: "۴ تا ۸ سال",
        description: "ربات مهربانی که هر نقاشی را زنده می‌کند.",
      },
      {
        id: "nargol",
        emoji: "🦊",
        name: "نارگل",
        age: "۵ تا ۹ سال",
        description: "دختر ماجراجویی برای قصه‌های تشویقی.",
      },
      {
        id: "custom",
        emoji: "✨",
        name: "شخصیت شما",
        age: "اختصاصی",
        description: "از روی عکس کودک شما ساخته می‌شود.",
      },
    ],
    cta: { label: "مشاهده همه‌ی شخصیت‌ها", href: "/characters" },
  },

  safety: {
    eyebrow: "ایمنی و حریم خصوصی",
    title: "هیچ‌کس جز خانواده‌ی شما کودکتان را نمی‌بیند",
    description:
      "هیچ محتوایی به‌صورت عمومی منتشر نمی‌شود. عکس‌ها فقط برای ساخت سفارش شما استفاده می‌شوند و هر زمان بخواهید حذف می‌شوند.",
    points: [
      {
        id: "no-public-posting",
        mark: "۱",
        title: "بدون انتشار عمومی",
        description: "هیچ خروجی‌ای در شبکه‌های اجتماعی یا گالری عمومی قرار نمی‌گیرد.",
      },
      {
        id: "one-click-delete",
        mark: "۲",
        title: "حذف در یک کلیک",
        description: "عکس‌ها و سفارش‌ها را هر زمان به‌طور کامل پاک کنید.",
      },
      {
        id: "no-child-account",
        mark: "۳",
        title: "بدون حساب کودک",
        description: "همه‌چیز از طریق حساب والدین مدیریت می‌شود.",
      },
      {
        id: "human-review",
        mark: "۴",
        title: "بازبینی انسانی",
        description: "هر سفارش پیش از تحویل توسط تیم بررسی می‌شود.",
      },
    ],
    imageAlt: "خانواده در حال تماشای سفارش کودک روی تبلت",
    note: "همه‌ی سفارش‌ها پیش از تحویل توسط تیم انسانی بررسی می‌شوند.",
  },

  pricing: {
    eyebrow: "قیمت‌گذاری",
    title: "پلنی متناسب با تعداد کارتون‌هایی که می‌سازید انتخاب کنید",
    featuredPlanIds: ["starter", "plus", "premium"],
    linkLabel: "مشاهده همه‌ی پلن‌ها و جزئیات آب‌نبات‌ها",
    linkHref: "/pricing",
    footnote:
      "پرداخت و کسر آب‌نبات هنوز در نسخه فعلی فعال نشده است. پیش از راه‌اندازی پرداخت، قیمت‌ها به‌صورت شفاف نمایش داده می‌شوند.",
  },

  testimonials: {
    title: "والدین چه می‌گویند",
    items: [
      {
        id: "samira",
        quote:
          "دخترم هر شب ویدئوی خودش را می‌بیند و می‌خندد. اینکه هیچ‌جا منتشر نمی‌شود برای ما مهم‌ترین بخش بود.",
        name: "سمیرا ر.",
        role: "مادر یک کودک ۵ ساله",
      },
      {
        id: "mohammad",
        quote:
          "نقاشی پسرم را فرستادیم و دو روز بعد یک انیمیشن کوتاه گرفتیم. باورش سخت بود که همان نقاشی خودش است.",
        name: "محمد ک.",
        role: "پدر دو کودک",
      },
      {
        id: "negar",
        quote:
          "برای تولد خواهرزاده‌ام یک پیام کارتونی ساختم؛ ساده‌ترین هدیه‌ای بود که بیشترین ذوق را داشت.",
        name: "نگار م.",
        role: "خاله‌ی یک کودک ۴ ساله",
      },
    ],
  },

  faqTeaser: {
    eyebrow: "سوالات متداول",
    title: "هر چیزی که والدین معمولاً می‌پرسند",
    questions: [
      "آیا کودک من حساب جداگانه دارد؟",
      "آیا عکس یا نقاشی کودک من عمومی می‌شود؟",
      "چگونه یک کارتون سفارش بدهم؟",
      "چه زمانی خروجی آماده می‌شود؟",
    ],
    linkLabel: "مشاهده همه‌ی سوالات متداول",
    linkHref: "/faq",
  },

  finalCta: {
    title: "امشب اولین کارتون کودکتان را بسازید",
    description: "چند دقیقه وقت می‌گیرد؛ نتیجه‌اش خاطره‌ای است که سال‌ها می‌ماند.",
    primaryCta: { label: "شروع ساخت کارتون", href: "#creation-types" },
    secondaryCta: { label: "مشاهده نمونه‌ها", href: "/examples" },
  },
};

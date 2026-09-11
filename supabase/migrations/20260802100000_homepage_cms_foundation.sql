-- =============================================================================
-- Cartoona — Homepage CMS Foundation (Phase 1)
-- =============================================================================
-- Adds the data model behind the future homepage editor:
--
--   public.homepage_content       one singleton row of editable homepage copy
--   public.homepage_media_assets  one metadata row per named media slot
--
-- Boundary: code owns structure, admin owns content. Neither table can express
-- layout, scroll behaviour, breakpoints, CSS, HTML or script — the application
-- validates every field against lib/homepage/validation.ts before it is stored
-- and again after it is read.
--
-- Scope note: this migration touches ONLY the two new tables above. It does not
-- read, alter or delete users, parent_profiles, orders, wallets, transactions,
-- purchases, payment attempts, coupons, referrals or requests. The single row it
-- inserts is configuration content, not user or business data.
--
-- No upload API and no storage bucket are created here; media delivery is a
-- later phase (see docs/HOMEPAGE_CMS_ARCHITECTURE.md).
-- =============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- HOMEPAGE CONTENT — singleton
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.homepage_content (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key       TEXT NOT NULL UNIQUE DEFAULT 'homepage'
                        CHECK (singleton_key = 'homepage'),
  content_json        JSONB NOT NULL
                        CHECK (jsonb_typeof(content_json) = 'object'),
  revision            INTEGER NOT NULL DEFAULT 1
                        CHECK (revision >= 1),
  updated_by_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.homepage_content IS
  'Editable marketing homepage copy. Exactly one row, addressed by singleton_key = ''homepage''. Structure, layout and motion stay in code.';
COMMENT ON COLUMN public.homepage_content.singleton_key IS
  'Fixed to ''homepage''. The CHECK plus UNIQUE constraint together permit exactly one row.';
COMMENT ON COLUMN public.homepage_content.content_json IS
  'HomepageContent object. Validated by the application on write and re-validated on read; malformed content falls back to bundled defaults.';
COMMENT ON COLUMN public.homepage_content.revision IS
  'Monotonic counter bumped by the admin write path. Used for optimistic concurrency and audit.';
COMMENT ON COLUMN public.homepage_content.updated_by_user_id IS
  'Admin who last saved. Nullable so the seeded row and system writes need no user.';

DROP TRIGGER IF EXISTS homepage_content_set_updated_at ON public.homepage_content;
CREATE TRIGGER homepage_content_set_updated_at
  BEFORE UPDATE ON public.homepage_content
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- HOMEPAGE MEDIA ASSETS — one current object per slot
-- ═════════════════════════════════════════════════════════════════════════════
-- Stores metadata only. `storage_path` is a key inside a storage bucket, never a
-- URL: an editor cannot point the homepage at an arbitrary origin. Slot keys are
-- constrained here and mirrored in lib/homepage/media-slots.ts.

CREATE TABLE IF NOT EXISTS public.homepage_media_assets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_key            TEXT NOT NULL UNIQUE
                        CHECK (slot_key IN (
                          'hero.background',
                          'hero.tv_video',
                          'sections.background',
                          'build_options.card_image',
                          'build_options.card_video',
                          'build_options.card_animation',
                          'safety.image'
                        )),
  media_type          TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  storage_path        TEXT NOT NULL
                        CHECK (char_length(trim(storage_path)) > 0
                               AND storage_path !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
                               AND storage_path NOT LIKE '//%'
                               AND storage_path NOT LIKE '%..%'),
  mime_type           TEXT NOT NULL CHECK (mime_type IN (
                          'image/png', 'image/jpeg', 'image/webp',
                          'video/mp4', 'video/webm'
                        )),
  byte_size           BIGINT NOT NULL CHECK (byte_size > 0),
  width               INTEGER NULL CHECK (width IS NULL OR width > 0),
  height              INTEGER NULL CHECK (height IS NULL OR height > 0),
  duration_seconds    NUMERIC NULL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  updated_by_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- An image has no duration; a video must not claim to be an image.
  CONSTRAINT homepage_media_type_matches_mime CHECK (
    (media_type = 'image' AND mime_type LIKE 'image/%' AND duration_seconds IS NULL)
    OR
    (media_type = 'video' AND mime_type LIKE 'video/%')
  )
);

COMMENT ON TABLE public.homepage_media_assets IS
  'Current media object for each named homepage slot. Metadata only — bytes live in storage. One row per slot, enforced by the UNIQUE constraint on slot_key.';
COMMENT ON COLUMN public.homepage_media_assets.slot_key IS
  'Closed set of design positions, mirrored in lib/homepage/media-slots.ts. Editors cannot invent slots.';
COMMENT ON COLUMN public.homepage_media_assets.storage_path IS
  'Object key inside the storage bucket. Never a URL: the CHECK rejects schemes, protocol-relative prefixes and path traversal.';
COMMENT ON COLUMN public.homepage_media_assets.byte_size IS
  'Size in bytes of the stored object, recorded at upload time.';
COMMENT ON COLUMN public.homepage_media_assets.duration_seconds IS
  'Video duration. Always NULL for images, enforced by homepage_media_type_matches_mime.';

DROP TRIGGER IF EXISTS homepage_media_assets_set_updated_at ON public.homepage_media_assets;
CREATE TRIGGER homepage_media_assets_set_updated_at
  BEFORE UPDATE ON public.homepage_media_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- RLS — no browser writes, ever
-- ═════════════════════════════════════════════════════════════════════════════
-- Both tables are readable by anyone (the homepage is public marketing content)
-- and writable by nobody through PostgREST. There is deliberately no INSERT,
-- UPDATE or DELETE policy on either table: with RLS enabled and no permissive
-- policy, every write from anon and authenticated — including a signed-in
-- admin's browser — is denied.
--
-- Admin writes will go through a server-side route that authenticates the caller
-- (lib/auth/require-admin.ts), validates the payload, and then uses the
-- service-role client, which bypasses RLS. That keeps the trust boundary on the
-- server where the validation lives, rather than trusting whatever a browser
-- sends.

ALTER TABLE public.homepage_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homepage_media_assets ENABLE ROW LEVEL SECURITY;

-- Read-only public policies. SELECT only.
DROP POLICY IF EXISTS "homepage_content_select_public" ON public.homepage_content;
CREATE POLICY "homepage_content_select_public" ON public.homepage_content
  FOR SELECT
  USING (TRUE);

DROP POLICY IF EXISTS "homepage_media_assets_select_public" ON public.homepage_media_assets;
CREATE POLICY "homepage_media_assets_select_public" ON public.homepage_media_assets
  FOR SELECT
  USING (TRUE);

-- Belt and braces: strip write privileges at the grant level too, so a future
-- permissive policy added by mistake still cannot be exercised by these roles.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.homepage_content FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.homepage_media_assets FROM anon, authenticated;

GRANT SELECT ON public.homepage_content TO anon, authenticated;
GRANT SELECT ON public.homepage_media_assets TO anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- SEED — the currently approved homepage copy
-- ═════════════════════════════════════════════════════════════════════════════
-- Configuration content, not user or business data. Idempotent: ON CONFLICT DO
-- NOTHING means re-running the migration never overwrites copy an admin has
-- since edited. The same object ships in lib/homepage/default-content.ts as the
-- runtime fallback.

INSERT INTO public.homepage_content (singleton_key, content_json, revision)
VALUES (
  'homepage',
  $homepage_seed$
{
  "hero": {
    "eyebrow": "استودیوی خصوصی ساخت کارتون برای خانواده‌ها",
    "title": "خاطره‌های کارتونی جادویی بسازید",
    "description": "با کارتونا، والدین می‌توانند برای کودک خود تصویر، ویدئو یا انیمیشن کارتونی اختصاصی سفارش دهند؛ امن، خصوصی و کاملاً تحت کنترل والدین.",
    "primaryCta": {
      "label": "شروع ساخت کارتون",
      "href": "#creation-types"
    },
    "secondaryCta": {
      "label": "مشاهده نمونه‌ها",
      "href": "/examples"
    },
    "trustLine": "تحت کنترل والدین · خصوصی برای خانواده · بدون اشتراک‌گذاری عمومی"
  },
  "buildOptions": {
    "title": "چه چیزی می‌خواهید بسازید؟",
    "description": "یکی از روش‌های ساخت را انتخاب کنید. جزئیات درخواست را ابتدا وارد می‌کنید و فقط هنگام ثبت نهایی وارد حساب می‌شوید یا حساب می‌سازید.",
    "cards": [
      {
        "id": "image",
        "badge": "تصویر",
        "badgeVariant": "default",
        "title": "تصویر کارتونی اختصاصی",
        "description": "یک تصویر کارتونی شخصی‌سازی‌شده با شخصیت، صحنه و سبک دلخواه بسازید.",
        "cta": {
          "label": "شروع ساخت تصویر",
          "href": "/create-image"
        },
        "media": "card_image"
      },
      {
        "id": "video",
        "badge": "ویدیو",
        "badgeVariant": "info",
        "title": "ویدیوی کارتونی",
        "description": "یک داستان یا پیام کوتاه را به ویدیوی کارتونی شخصی‌سازی‌شده تبدیل کنید.",
        "cta": {
          "label": "شروع ساخت ویدیو",
          "href": "/request-video"
        },
        "media": "card_video"
      },
      {
        "id": "drawing_animation",
        "badge": "نقاشی متحرک",
        "badgeVariant": "success",
        "title": "متحرک‌سازی نقاشی",
        "description": "نقاشی کودک را به یک انیمیشن کوتاه و زنده تبدیل کنید.",
        "cta": {
          "label": "شروع متحرک‌سازی",
          "href": "/animate-drawing"
        },
        "media": "card_animation"
      }
    ],
    "footnote": "می‌توانید ابتدا نوع و جزئیات ساخت را انتخاب کنید؛ ورود یا ساخت حساب فقط هنگام ثبت نهایی درخواست لازم است."
  },
  "characters": {
    "eyebrow": "شخصیت‌ها",
    "title": "شخصیت‌های دوست‌داشتنی کارتونا",
    "description": "یکی از شخصیت‌های اصلی را انتخاب کنید یا از روی عکس کودکتان یک شخصیت اختصاصی بسازید. همه‌ی شخصیت‌ها برای سنین کودکی طراحی شده‌اند.",
    "cards": [
      {
        "id": "mimi",
        "emoji": "🐰",
        "name": "میمی",
        "age": "۳ تا ۶ سال",
        "description": "خرگوش کنجکاوی که عاشق قصه‌های شب است."
      },
      {
        "id": "babu",
        "emoji": "🤖",
        "name": "بابو",
        "age": "۴ تا ۸ سال",
        "description": "ربات مهربانی که هر نقاشی را زنده می‌کند."
      },
      {
        "id": "nargol",
        "emoji": "🦊",
        "name": "نارگل",
        "age": "۵ تا ۹ سال",
        "description": "دختر ماجراجویی برای قصه‌های تشویقی."
      },
      {
        "id": "custom",
        "emoji": "✨",
        "name": "شخصیت شما",
        "age": "اختصاصی",
        "description": "از روی عکس کودک شما ساخته می‌شود."
      }
    ],
    "cta": {
      "label": "مشاهده همه‌ی شخصیت‌ها",
      "href": "/characters"
    }
  },
  "safety": {
    "eyebrow": "ایمنی و حریم خصوصی",
    "title": "هیچ‌کس جز خانواده‌ی شما کودکتان را نمی‌بیند",
    "description": "هیچ محتوایی به‌صورت عمومی منتشر نمی‌شود. عکس‌ها فقط برای ساخت سفارش شما استفاده می‌شوند و هر زمان بخواهید حذف می‌شوند.",
    "points": [
      {
        "id": "no-public-posting",
        "mark": "۱",
        "title": "بدون انتشار عمومی",
        "description": "هیچ خروجی‌ای در شبکه‌های اجتماعی یا گالری عمومی قرار نمی‌گیرد."
      },
      {
        "id": "one-click-delete",
        "mark": "۲",
        "title": "حذف در یک کلیک",
        "description": "عکس‌ها و سفارش‌ها را هر زمان به‌طور کامل پاک کنید."
      },
      {
        "id": "no-child-account",
        "mark": "۳",
        "title": "بدون حساب کودک",
        "description": "همه‌چیز از طریق حساب والدین مدیریت می‌شود."
      },
      {
        "id": "human-review",
        "mark": "۴",
        "title": "بازبینی انسانی",
        "description": "هر سفارش پیش از تحویل توسط تیم بررسی می‌شود."
      }
    ],
    "imageAlt": "خانواده در حال تماشای سفارش کودک روی تبلت",
    "note": "همه‌ی سفارش‌ها پیش از تحویل توسط تیم انسانی بررسی می‌شوند."
  },
  "pricing": {
    "eyebrow": "قیمت‌گذاری",
    "title": "پلنی متناسب با تعداد کارتون‌هایی که می‌سازید انتخاب کنید",
    "featuredPlanIds": [
      "starter",
      "plus",
      "premium"
    ],
    "linkLabel": "مشاهده همه‌ی پلن‌ها و جزئیات آب‌نبات‌ها",
    "linkHref": "/pricing",
    "footnote": "پرداخت و کسر آب‌نبات هنوز در نسخه فعلی فعال نشده است. پیش از راه‌اندازی پرداخت، قیمت‌ها به‌صورت شفاف نمایش داده می‌شوند."
  },
  "testimonials": {
    "title": "والدین چه می‌گویند",
    "items": [
      {
        "id": "samira",
        "quote": "دخترم هر شب ویدئوی خودش را می‌بیند و می‌خندد. اینکه هیچ‌جا منتشر نمی‌شود برای ما مهم‌ترین بخش بود.",
        "name": "سمیرا ر.",
        "role": "مادر یک کودک ۵ ساله"
      },
      {
        "id": "mohammad",
        "quote": "نقاشی پسرم را فرستادیم و دو روز بعد یک انیمیشن کوتاه گرفتیم. باورش سخت بود که همان نقاشی خودش است.",
        "name": "محمد ک.",
        "role": "پدر دو کودک"
      },
      {
        "id": "negar",
        "quote": "برای تولد خواهرزاده‌ام یک پیام کارتونی ساختم؛ ساده‌ترین هدیه‌ای بود که بیشترین ذوق را داشت.",
        "name": "نگار م.",
        "role": "خاله‌ی یک کودک ۴ ساله"
      }
    ]
  },
  "faqTeaser": {
    "eyebrow": "سوالات متداول",
    "title": "هر چیزی که والدین معمولاً می‌پرسند",
    "questions": [
      "آیا کودک من حساب جداگانه دارد؟",
      "آیا عکس یا نقاشی کودک من عمومی می‌شود؟",
      "چگونه یک کارتون سفارش بدهم؟",
      "چه زمانی خروجی آماده می‌شود؟"
    ],
    "linkLabel": "مشاهده همه‌ی سوالات متداول",
    "linkHref": "/faq"
  },
  "finalCta": {
    "title": "امشب اولین کارتون کودکتان را بسازید",
    "description": "چند دقیقه وقت می‌گیرد؛ نتیجه‌اش خاطره‌ای است که سال‌ها می‌ماند.",
    "primaryCta": {
      "label": "شروع ساخت کارتون",
      "href": "#creation-types"
    },
    "secondaryCta": {
      "label": "مشاهده نمونه‌ها",
      "href": "/examples"
    }
  }
}  $homepage_seed$::jsonb,
  1
)
ON CONFLICT (singleton_key) DO NOTHING;


-- ═════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═════════════════════════════════════════════════════════════════════════════
-- Both tables are tiny and looked up by their unique key, which already has an
-- implicit index. No additional indexes are warranted.

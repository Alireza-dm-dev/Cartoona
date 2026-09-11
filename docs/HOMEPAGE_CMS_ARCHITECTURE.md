# Homepage CMS Architecture

## Objective

Let Cartoona Admin manage the marketing homepage's **words and pictures** without
being able to touch how the page is **built**. Editors change copy, CTA labels,
destinations, testimonials, FAQ selections and media. They cannot change scroll
behaviour, layout, breakpoints, motion, colour, or anything executable.

## Content ownership boundary

| Admin owns (content) | Code owns (structure) |
|---|---|
| Hero eyebrow, title, description, trust line | Hero framing: `HERO_ZOOM`, `HERO_TV_FOCUS` |
| CTA labels and internal destinations | The TV overlay rect `TV_SCREEN_RECT` |
| Build-option card copy, badge, destination | Horizontal story mechanics, `PANEL_TRAVEL_VW` |
| Character card copy, emoji, age band | Card tint gradients (raw CSS) |
| Safety points, image alt text, note | Breakpoints, the `lg` horizontal-story cutoff |
| Which pricing plans are featured | Plan names, prices, candy amounts (`config/plans.ts`) |
| Testimonial quotes, names, roles | Section order and component hierarchy |
| FAQ teaser question selection | FAQ answer bodies (`config/faqs.ts`, shared with `/faq`) |
| Media files, per named slot | Which slot each component reads |
| — | Site header / nav labels and routes |
| — | API routes, auth rules, RLS |

Three things follow from that table and are enforced, not just documented:

- **No executable content.** No HTML, Markdown, CSS or script fields exist in the
  contract. `validateHomepageContent` rejects any string containing `<…>`.
- **No external destinations.** Every href must be an internal absolute path or a
  same-page anchor. `javascript:`, `data:`, `http(s):`, `mailto:` and
  protocol-relative `//host` are all rejected. External links are a deliberate
  later addition with their own allowlist.
- **No arbitrary media.** Media is addressed by a slot key from a closed set and
  stored as a storage object key, never a URL.

### Why pricing and FAQ bodies stay in code

`pricing.featuredPlanIds` selects *which* plans appear; prices and candy amounts
stay in `config/plans.ts`. An editor must never be one text field away from
changing what a customer is charged.

`faqTeaser.questions` selects *which* questions appear, matched against
`config/faqs.ts`. Storing the selection rather than copies of the Q&A keeps the
teaser and the `/faq` page from drifting apart. A full FAQ CMS is a later phase.

## The `HomepageContent` contract

`lib/homepage/types.ts`. Eight sections, every field explicitly typed — no `any`,
no `Record<string, unknown>`, no untyped blobs:

```
HomepageContent
├── hero          eyebrow, title, description, primaryCta, secondaryCta, trustLine
├── buildOptions  title, description, cards[], footnote
├── characters    eyebrow, title, description, cards[], cta
├── safety        eyebrow, title, description, points[], imageAlt, note
├── pricing       eyebrow, title, featuredPlanIds[], linkLabel, linkHref, footnote
├── testimonials  title, items[]
├── faqTeaser     eyebrow, title, questions[], linkLabel, linkHref
└── finalCta      title, description, primaryCta, secondaryCta
```

Repeatable items (`cards`, `points`, `items`) carry a stable `id` — lowercase
slug, unique within its collection — so reordering and relabelling never
invalidate a React key or an editor's reference.

Bounded enums rather than free strings: `badgeVariant` is one of
`default | info | success`; a card's `media` is one of
`card_image | card_video | card_animation`.

## Singleton strategy

`public.homepage_content` holds exactly one row, addressed by
`singleton_key = 'homepage'`. Uniqueness is enforced twice — `UNIQUE` plus
`CHECK (singleton_key = 'homepage')` — so a second row is impossible rather than
merely discouraged.

`revision` (≥ 1) is bumped by the admin write path, giving optimistic concurrency
for the editor and an audit trail. `updated_by_user_id` references
`public.users` and is nullable so the seeded row needs no author.

## Media slot strategy

`lib/homepage/media-slots.ts` declares the closed set; the same list is a `CHECK`
constraint on `homepage_media_assets.slot_key`. Both must be updated together.

| Slot | Type | Current file | Geometry-coupled |
|---|---|---|---|
| `hero.background` | image | `/images/homepage/sections-bg.png` | **yes** |
| `hero.tv_video` | video | `/videos/homepage/hero-tv.mp4` | no |
| `sections.background` | image | `/images/homepage/sections-bg.png` | **yes** |
| `build_options.card_image` | image | `/images/homepage/card-image.jpg` | no |
| `build_options.card_video` | video | `/videos/homepage/build-video.mp4` | no |
| `build_options.card_animation` | video | `/videos/homepage/build-animate.mp4` | no |
| `safety.image` | image | `/images/homepage/family-tablet.jpg` | no |

**Geometry coupling is the sharpest edge in this design.** The hero measures its
TV video overlay against the exact pixel geometry of `sections-bg.png`, and the
sections layer crops to the bottom ~63% specifically to keep that same television
out of view. Swapping either background without preserving the TV's fractional
position will put the video outside the bezel and may drag the TV into the
sections backdrop. The upload phase must either warn loudly on these two slots or
validate the replacement's TV placement. `HOMEPAGE_MEDIA_SLOT_SPECS` carries the
`geometryCoupled` flag so the editor can surface it.

One row per slot, enforced by `UNIQUE (slot_key)`: replacing media updates the
row rather than accumulating history.

## Fallback strategy

The homepage must render regardless of database state. `resolveHomepageContent`
(pure, in `lib/homepage/content-resolution.ts`) resolves four cases:

| Situation | `source` | Result |
|---|---|---|
| Valid row | `database` | Stored content, with its revision |
| No row (fresh environment) | `default-missing-row` | `DEFAULT_HOMEPAGE_CONTENT` |
| Row fails validation | `default-invalid-content` | `DEFAULT_HOMEPAGE_CONTENT` |
| Read threw or errored | `default-read-error` | `DEFAULT_HOMEPAGE_CONTENT` |

Content is validated **on read as well as on write**. A row that was valid when
written but no longer satisfies a tightened contract — or that was altered out of
band — falls back rather than rendering. This is what makes a stored
`javascript:` href unable to reach the page even if it somehow got persisted.

Diagnostics carry field *paths* only, never stored values, so logs cannot become
an exfiltration channel. No database error text ever reaches the browser.

`lib/homepage/service.ts` is the thin IO shell around the pure resolver.

## Security model

- **No browser writes at all.** Both tables have RLS enabled with a `SELECT`-only
  policy and no `INSERT`/`UPDATE`/`DELETE` policy. Write privileges are also
  `REVOKE`d from `anon` and `authenticated` at the grant level, so a permissive
  policy added by mistake later still cannot be exercised. Verified against a
  throwaway Postgres: anon and authenticated INSERT/UPDATE/DELETE all fail with
  `permission denied`.
- **Writes go through the server.** The future admin route authenticates via
  `requireAdmin()` (`lib/auth/require-admin.ts`, reusing the existing
  `users.role` model — `admin` and `super_admin` only), validates the payload,
  then writes with the service-role client. The trust boundary sits on the
  server, next to the validation, rather than trusting a browser payload.
- **Public read is intentional.** Homepage copy is public marketing content;
  there is nothing to leak. Serving it through the server client is still
  preferred, so the anon read grant is a convenience, not a dependency.
- **Storage paths, not URLs.** `storage_path` is `CHECK`-constrained to reject
  schemes, protocol-relative prefixes and `..` traversal.

## Future upload architecture (not built)

Planned bucket: **`homepage-media`**.

- Admin/super-admin upload only; no parent or anonymous write path.
- MIME allowlist — images `image/png`, `image/jpeg`, `image/webp`; video
  `video/mp4`, `video/webm`. Mirrored in `HOMEPAGE_MEDIA_MIME_ALLOWLIST` and in
  the table's `mime_type` CHECK.
- Per-type size limits, enforced at the bucket and re-checked server-side.
- **Server-generated storage paths.** The client never chooses the key; the
  server derives it from the slot and a random component.
- Replacement is a two-step with rollback: upload the new object, update the row,
  and delete the old object **only after the row update commits**. A failed
  update must leave the previous asset serving.
- Delivery: public-read bucket for marketing assets, matching the existing
  `example-media` convention. Revisit if any homepage asset ever becomes
  sensitive.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| **1. Foundation** | Contract, defaults, tables, slots, validation, read service, tests | ✅ complete |
| **2. Admin editor** | `/admin/homepage` UI + `GET`/`PUT /api/admin/homepage` behind `requireAdminHomepageAuth`, revision-checked via `public.update_homepage_content_trusted` | ✅ complete |
| **3. Media manager** | `homepage-media` bucket, atomic replace API, hero calibration, shared/separate backgrounds, tabbed `/admin/homepage` media UI | ✅ complete |
| **4A. Runtime wiring** | Homepage components read `getResolvedHomepage()` + CMS media/layout; all text Admin-editable; current homepage exact fallback; one resolver owns reads | ✅ complete |
| **4B. Controlled migration** | Three migrations applied in timestamp order; CMS values wired into components; duplicated literals removed; smoke validation | ✅ complete |
| **5. FAQ + pricing CMS** | Only if the product needs editable FAQ bodies or plan copy | speculative |

Phase 4 was deliberately last. Now that it has landed, the resolver owns the
rendered copy and the marketing components hold none of their own. Instead of
being a transcription that must be kept in step, `DEFAULT_HOMEPAGE_CONTENT` is
now purely the fallback served when a stored row is missing or fails validation.

## Phase 2: admin editor (implementation notes)

**Routes.** `GET /api/admin/homepage` returns `{ content, revision, isDefault,
source }`; `PUT /api/admin/homepage` accepts `{ content, expectedRevision }`.
Both require `admin` / `super_admin` via `requireAdminHomepageAuth`
(`lib/admin/homepage/service.ts`, same `users.role` model as every other admin
route — no second role system). 422 carries per-field `errors` for inline
display; 409 carries the current server snapshot for reload-on-conflict.

**Write path.** The route validates the full document with
`validateHomepageContent` (pure parsing in
`lib/admin/homepage/put-validation.ts`), then calls
`public.update_homepage_content_trusted` through the service-role client
(`20260802110000_homepage_cms_admin_write.sql`). The RPC re-verifies the admin
role via `public.is_admin_user_id`, locks the singleton `FOR UPDATE`, rejects
stale revisions with `homepage_admin_conflict`, bumps `revision` atomically and
returns the new snapshot. RPC codes map to Persian HTTP errors in
`lib/admin/homepage/errors.ts`; raw DB strings never reach the browser.

**Editor.** `/admin/homepage` (server wrapper +
`components/admin/homepage/homepage-editor.tsx`) edits every safe text/content
field: all eight sections, bounded-enum selects (`badgeVariant`, card `media`),
`featuredPlanIds` checkboxes from `config/plans.ts` (prices stay in code), plus
add/remove for testimonial items and FAQ questions only. No image/video
upload, no media manager, no geometry controls (`HERO_ZOOM`, `HERO_TV_FOCUS`,
`TV_SCREEN_RECT`, crops, story mechanics stay code-controlled), no
draft/publish, no history UI, no reordering, no public-homepage wiring. Live
validation via `validateHomepageContent`, unsaved-changes tracking with a
`beforeunload` guard, save/reset/reload-on-conflict UX. Pure state decisions
live in `lib/admin/homepage/editor-state.ts`.

**Degraded mode.** When the CMS tables are absent, the editor opens on bundled
defaults with `revision: null`: every input and save is disabled and a banner
explains that applying the migrations is a separate deployment step. No
browser-side database fallback was added — production security is unchanged.

**Migration state.** `20260802100000_homepage_cms_foundation.sql` exists
locally and is NOT applied to main; `20260802110000_homepage_cms_admin_write.sql`
is new in this phase. Both are pending: validated locally/disposable only,
never pushed to `oucyhmrnzahlhqjfqcge`. Production application is a separate,
explicitly approved deployment step.

## Phase 3: media manager (implementation notes)

**Storage.** `homepage-media` bucket (`20260802120000_homepage_cms_media.sql`):
public read, `file_size_limit` 50 MiB, MIME array png/jpeg/webp/mp4/webm — and
deliberately **zero** INSERT/UPDATE/DELETE storage policies, so no browser
(even an admin's) can upload directly. All uploads/removals go through the
service-role client inside the admin routes. Object keys are server-generated
(`homepage/<slot-slug>/<timestamp>-<uuid>.<ext>`, extension from validated
MIME only); original filenames never affect the path.

**Validation (no new dependencies).** `lib/admin/homepage/media-validation.ts`
(pure): slot allowlist → MIME allowlist → magic-byte sniff (PNG/JPEG/WebP/
MP4/WebM) → per-slot caps (hero/sections images 12 MB, card/safety images
6 MB, videos 50 MB) → server-side dimension probing via hand-rolled
PNG/JPEG/WebP header parsers (images must yield dimensions). Video
width/height/duration stay nullable — no parser exists in the tree and browser
values are never persisted as authoritative metadata.

**Atomic commit (Correction 1).**
`public.record_homepage_media_replacement_trusted(...)` commits primary media
upsert + optional shared `sections.background` upsert + optional hero layout
update in ONE transaction (layout locked first, fixed lock order). API flow:
validate → upload → ONE RPC → RPC failure deletes the new object
best-effort (DB untouched) → success deletes superseded objects best-effort.
No multi-RPC hero path, no compensating DB rollback. Rollback matrix is the
pure `decideMediaRollback` (old objects never deleted before DB success).

**Trusted delete (Correction 2).** `public.delete_homepage_media_trusted`
locks, deletes, and returns the previous storage metadata for best-effort
cleanup — the API never mutates the table directly and never deletes the
object before metadata removal succeeds. Reverting is always safe: the public
homepage renders committed local assets until Phase 4.

**Geometry.** `public.homepage_hero_layout` singleton holds the normalized TV
rect (fractions only; seeded from `TV_SCREEN_RECT`), revision-guarded via
`update_homepage_hero_layout_trusted`. `hero.background` replacement REQUIRES
a valid rect — new art never silently inherits old placement. `HERO_ZOOM`,
`HERO_TV_FOCUS`, crop/story mechanics stay code-only with no DB
representation. **Phase 3 does not wire the public Hero to the layout table.**

**UI.** `/admin/homepage` is tabbed (هیرو، پس‌زمینه بخش‌ها، گزینه‌های ساخت،
ایمنی، متن‌ها): per-slot preview/metadata/source badge (پیش‌فرض پروژه /
رسانه CMS), pending summary + cancel, success/safe-Persian-error states,
two-step revert («بازگشت به فایل پیش‌فرض»). Hero tab adds sharing-mode radio
(one image for both slots vs separate), calibration dialog (drag + resize +
mandatory numeric % controls, aspect-deviation warning, explicit confirm
checkbox), and standalone recalibration via `PUT hero-layout`. Sections
replacement requires preview confirmation with the ~63 % crop guidance; crop
mechanics are not editable. No `storage_path`, service keys, or raw DB errors
reach the browser.

**Migration state.** All three CMS migrations remain pending and unapplied to
main (`oucyhmrnzahlhqjfqcge`): `20260802100000` (foundation),
`20260802110000` (content write), `20260802120000` (media, new this phase).
Validated on ephemeral local Postgres only (atomicity proven: stale-layout
conflict left both media rows and layout untouched). Production application
is a separate, explicitly approved deployment step.

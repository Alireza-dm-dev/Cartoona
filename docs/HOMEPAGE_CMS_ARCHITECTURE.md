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
| **2. Admin editor** | `/admin/homepage` UI + `PUT /api/admin/homepage` write route behind `requireAdmin`, revision-checked | next |
| **3. Media upload** | `homepage-media` bucket, upload/replace API, geometry-coupling warnings | later |
| **4. Runtime wiring** | Homepage components read `getHomepageContent()`; literals deleted from components | later |
| **5. FAQ + pricing CMS** | Only if the product needs editable FAQ bodies or plan copy | speculative |

Phase 4 is deliberately last: until then the components still own the rendered
copy, and `DEFAULT_HOMEPAGE_CONTENT` is the transcription of record. The two must
be kept in step until that phase deletes the duplication.

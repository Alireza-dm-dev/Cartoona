# Cartoona Roadmap

## MVP 0 — Design & Foundation (Current)

**Goal:** Bootstrap the project foundation — routes, design system, docs, and placeholder pages.

**What's included:**
- [x] Next.js App Router project with TypeScript and Tailwind CSS
- [x] Cartoona color palette and design tokens
- [x] Marketing pages (homepage, characters, examples, pricing, safety, FAQ)
- [x] Auth route layout (login, signup, parent consent placeholders)
- [x] Parent dashboard route layout and pages
- [x] Admin route layout and pages
- [x] Minimal reusable components (Button, Card, Badge, EmptyState, PageHeader, etc.)
- [x] Supabase client placeholders
- [x] Database schema draft (`db/schema.sql`)
- [x] Configuration files (characters, candy costs, plans, moderation rules)
- [x] Shared types
- [x] Project documentation (context, roadmap, architecture, design system, features, decisions)
- [x] README with setup instructions

## MVP 1 — Manual Request Platform (Next)

**Goal:** Working parent-to-admin request flow with manual fulfillment.

- [ ] Supabase Auth integration (parent signup/login)
- [ ] Real database setup and migration
- [x] Admin request queue + detail (read-only, real orders + type details + signed URLs)
- [ ] Order CRUD — parents submit requests, admins manage queue
- [x] Admin fulfilment — controlled status transitions, append-only history, final-media upload/approval/supersede, private `final-deliverables` bucket
- [ ] Parent dashboard — view order status, download content
- [ ] Private gallery — view completed creations
- [ ] Parent consent flow
- [ ] Basic moderation workflow

## MVP 2 — Controlled Image Generation

**Goal:** Integrate controlled AI image generation with admin oversight.

- [ ] AI image provider integration (API-agnostic adapter)
- [ ] Controlled generation wizard — character + theme + prompt builder
- [ ] Admin review before delivery
- [ ] Safety moderation automation for prompts
- [ ] Media asset management

## MVP 3 — Payments

**Goal:** Candy credit system with real payments.

- [ ] Stripe integration
- [ ] Candy pack purchases
- [ ] Candy balance deduction on request submission
- [ ] Transaction history
- [ ] Refund handling

## MVP 4 — Launch Polish

**Goal:** Production-ready platform with safety and polish.

- [ ] RLS policies for all tables
- [ ] Storage buckets and policies
- [ ] Audit logging
- [ ] Account deletion flow
- [ ] Data export
- [ ] Email notifications
- [ ] Performance optimization
- [ ] Security review
- [ ] Beta testing

## Homepage CMS

- [x] **Phase 1 — Foundation.** `HomepageContent` contract, default content,
      `homepage_content` singleton + `homepage_media_assets` tables, media slot
      registry, validation, server read service with fallback, 40 unit tests.
- [x] **Phase 2 — Admin editor.** `/admin/homepage` copy UI and write route
      behind `requireAdminHomepageAuth`, revision-checked, validating with the
      shared contract.
- [x] **Phase 3 — Media manager.** `homepage-media` bucket (no browser writes),
      atomic single-RPC upload/replace with storage rollback, hero TV-rect
      calibration (normalized, revision-checked), shared/separate hero +
      sections backgrounds, tabbed admin media UI, revert-to-local-fallback.
- [x] **Phase 4A — Runtime wiring.** Homepage components read `getResolvedHomepage()` + CMS media/layout; all text Admin-editable; current homepage exact fallback; one resolver owns reads. Types/lint/build/tests pass.
- [x] **Phase 4B — Controlled migration.** All three migrations applied in
      timestamp order: the `homepage_content`, `homepage_media_assets` and
      `homepage_hero_layout` tables, the four `*_trusted` RPCs and the public
      `homepage-media` bucket are live. CMS values are wired into the
      components and no marketing section holds literal copy. Smoke
      validation passed: 409 unit tests, lint clean, production build, and
      the homepage verified at 1440/1280/1024/390/375 with no horizontal
      overflow.

## Future (Post-MVP)

- Video generation
- Drawing animation
- Public gallery (with strict opt-in)
- Multiple character scenes
- Enhanced prompt builder
- Mobile app

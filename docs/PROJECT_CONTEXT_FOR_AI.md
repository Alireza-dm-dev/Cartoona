# Cartoona: Project Context for AI Coding Executors

## What is Cartoona

Cartoona is a **parent-first personalized cartoon creation platform**. Parents upload drawings, describe scenes, and request custom cartoons (images, videos, animations) featuring an original cast of characters. Every feature is designed with the parent as the primary user — children may help choose characters, but the parent controls everything.

## Parent-First Rule

> **The parent is always the primary user.**
> - Only parents can create accounts.
> - Only parents can upload, request, pay, download, and delete.
> - Children never have independent accounts.
> - No social features.
> - No public sharing without explicit parent opt-in.
> - All content is private by default.

## MVP Strategy

The MVP is a **manual request platform**. Parents submit requests, admins fulfill them. Full AI automation comes later. The goal is to validate the workflow, safety controls, and parent trust before adding complexity.

**Current phase — Foundation (MVP 0):**
- Marketing pages
- Auth route structure
- Parent dashboard route structure
- Admin route structure
- Design system foundation
- Supabase-ready structure
- Database schema documentation
- Required docs
- Placeholder pages only

## Current Foundation Status

This is **MVP 0 — Design & Foundation**. The project has:

- [x] Next.js App Router project with TypeScript and Tailwind CSS v4
- [x] Placeholder route structure (29 routes across 4 route groups)
- [x] Design tokens in `app/globals.css` (11 custom colors, radius/spacing system)
- [x] Minimal reusable UI components (Button, Card, Badge, EmptyState, etc.)
- [x] Marketing pages (homepage, characters, examples, pricing, safety, FAQ)
- [x] Auth route shells (login, signup, parent consent — all placeholders)
- [x] Parent dashboard route shells (10 pages — all placeholders)
- [x] Admin route shells (9 pages — all placeholders)
- [x] Draft database schema (`db/schema.sql` — 12 tables, not applied)
- [x] Configuration files (characters, candy costs, plans, moderation rules)
- [x] Shared TypeScript types (app.ts, database.ts)
- [x] Project documentation (6 docs files + README + AGENTS.md)
- [ ] Supabase packages are **not installed** — clients throw if called
- [ ] Auth is **not implemented** — all routes are public
- [ ] Storage is **not configured** — no buckets or policies
- [ ] Stripe is **not configured** — no payment flow
- [ ] API routes are **not implemented** — `app/api/` does not exist
- [ ] Tests are **not configured** — test directories are empty
- [ ] Middleware/auth guards are **not added** — no route protection

## Auth + RLS Plan

See `docs/AUTH_RLS_PLAN.md` for the detailed architecture plan. Do not implement auth until explicitly directed.

## What NOT to Build Yet

Do not build any of the following until explicitly directed:

- Full authentication (Supabase Auth integration) — packages not installed
- Supabase connection — packages not installed
- Stripe checkout or payment flows
- AI image/video/animation generation (APIs, providers, adapters)
- Request submission logic or order CRUD
- Admin fulfillment logic (review/upload/deliver)
- Public gallery or sharing features
- Social features (likes, comments, follows)
- Child-owned accounts or child login
- Famous or licensed character system
- WhatsApp/Telegram or external delivery automation
- Marketplace or print-on-demand
- Voice cloning
- Complex analytics or dashboards
- API routes (`app/api/`)
- Middleware or auth guards
- Advanced prompt engineering panel

## Design Source of Truth

The project uses a Cartoona-specific color palette defined as CSS variables and Tailwind theme tokens in `app/globals.css`. The palette source:

- Cream Background: `#FFF7E8`
- Candy Pink: `#FF6FB1`
- Sky Blue: `#5BC7F7`
- Sunshine Yellow: `#FFD84D`
- Mint Green: `#7EE6B8`
- Soft Purple: `#A78BFA`
- Coral: `#FF8A65`
- Parent Navy: `#26324A`
- Text Dark: `#2B2B35`
- Soft Border: `#F0DCC7`
- White: `#FFFFFF`

Tailwind classes use the `-candy-pink`, `-sky-blue`, `-sunshine-yellow`, `-mint-green`, `-soft-purple`, `-coral`, `-parent-navy`, `-text-dark`, `-soft-border`, `-cream` suffixes (e.g., `bg-candy-pink`, `text-parent-navy`).

Typography uses Geist (already configured) as the primary sans-serif font via the `font-sans` variable.

## Safety & Privacy Principles

1. **Parent-only accounts** — No child-owned accounts.
2. **Private by default** — All content is family-private.
3. **Manual moderation** — Content reviewed before delivery.
4. **Data control** — Parents can export and delete all data.
5. **No data selling** — Child data is never sold.
6. **Consent first** — Explicit parent consent required.

## How AI Coding Executors Should Work on This Repo

1. **Read the docs first.** Check `docs/` for project context, architecture, design system, and decisions before making changes.
2. **Follow the design system.** Use Cartoona colors, spacing, and components. Do not invent new design directions.
3. **No full features.** Unless the task explicitly requires it, do not implement full business workflows (payment, AI generation, auth, etc.).
4. **Placeholder over fake.** Use EmptyState, TODO comments, and placeholder descriptions instead of fake complex data.
5. **PR review mindset.** If something is unclear, add a TODO comment rather than guessing.
6. **No duplicate helpers.** Check if a component or utility already exists before creating a new one.
7. **Keep it minimal.** Foundation-first. Do not over-engineer.

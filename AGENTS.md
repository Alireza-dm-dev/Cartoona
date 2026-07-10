# Cartoona — Agent Guardrails

## Product Summary

Cartoona is a parent-first personalized cartoon creation platform. Parents control accounts, uploads, payments, consent, privacy, downloads, and deletion. Children may help choose characters, but the parent is always the primary user.

## Status: MVP 0 — Foundation Only

No auth, no database connection, no API routes, no business logic. All 29 routes are static placeholders. This is a design and route structure foundation.

## Tech Stack

- Next.js 16 App Router, TypeScript, Tailwind CSS v4
- Geist font (via next/font)
- Custom Cartoona design tokens in `app/globals.css`
- Supabase (planned — packages not installed)
- Stripe (planned — not implemented)

## Design Source of Truth

All colors and tokens: `app/globals.css` (`@theme inline` block). Docs: `docs/DESIGN_SYSTEM.md`. Do not invent new colors or design direction.

## What You May Edit

- Placeholder page content (titles, descriptions, layout)
- UI components inside `components/ui/`
- Documentation in `docs/`
- Configuration files in `config/`
- Type definitions in `types/`
- Stub files in `lib/` (keep them as stubs)

## What You Must Not Build Yet

- Full authentication (Supabase Auth integration)
- Supabase connection (packages not installed)
- Stripe checkout or payment flows
- AI image/video/animation generation
- Request submission logic or order CRUD
- Admin fulfillment logic
- Public gallery or sharing features
- Social features (likes, comments, follows)
- Child-owned accounts or child login
- Famous or licensed character system
- WhatsApp/Telegram or external delivery
- Marketplace or print-on-demand
- Voice cloning
- Complex analytics or dashboards
- API routes (`app/api/`)
- Middleware or auth guards

## Workflow Rules

1. **One focused change per prompt.** Do not bundle unrelated work.
2. **Inspect before editing.** Read at least the file you are changing and its imports.
3. **Do not invent new product flows.** If the task is unclear, write a TODO in the docs.
4. **No child-owned accounts.** Ever. Children have optional profiles under parent control.
5. **No famous characters.** Only original Cartoona characters (see `config/characters.ts`).
6. **No public child media.** All content is private by default.
7. **Keep foundation minimal.** Do not over-engineer. Do not add dependencies without approval.
8. **If unsure, write a TODO.** Do not guess product requirements.

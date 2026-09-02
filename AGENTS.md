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

## Persian-first / RTL-first

Cartoona is Persian-first and RTL-first. Do not create English-first or LTR-only UI unless explicitly requested. All user-facing text must be in Persian. Layout must default to right-to-left direction.

## Workflow Rules

1. **One focused change per prompt.** Do not bundle unrelated work.
2. **Inspect before editing.** Read at least the file you are changing and its imports.
3. **Do not invent new product flows.** If the task is unclear, write a TODO in the docs.
4. **No child-owned accounts.** Ever. Children have optional profiles under parent control.
5. **No famous characters.** Only original Cartoona characters (see `config/characters.ts`).
6. **No public child media.** All content is private by default.
7. **Keep foundation minimal.** Do not over-engineer. Do not add dependencies without approval.
8. **If unsure, write a TODO.** Do not guess product requirements.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

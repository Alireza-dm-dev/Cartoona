# Cartoona 🎨

A **parent-first personalized cartoon creation platform** for families.

Parents control everything — accounts, uploads, payments, consent, privacy, downloads, and deletion. Children may help choose characters and themes, but the parent is always the primary user.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16 (App Router) | Framework |
| TypeScript | Language |
| Tailwind CSS v4 | Styling |
| Supabase | Database, Auth, Storage (setup in progress) |
| Stripe | Payments (future) |

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the marketing homepage.

> **Node.js:** Use the version recommended by the current Next.js release. Avoid very new experimental Node.js versions if build or dependency issues appear.

## Environment Variables

See `.env.example` for all required variables. You'll need:

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (server only)
- `NEXT_PUBLIC_SITE_URL` — Production site URL

Stripe variables are listed for future use.

## Folder Structure

```
app/
  (marketing)/   # Public marketing pages
  (auth)/        # Login, signup, consent
  (dashboard)/   # Parent dashboard
  admin/         # Admin console
components/      # Reusable UI components
lib/             # Utilities, clients, business logic
db/              # Database schema and migrations
types/           # Shared TypeScript types
config/          # App configuration
docs/            # Project documentation
tests/           # Test files
```

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |

## Safety Note

Cartoona is built with **parent-first safety and privacy** principles:

- Only parents can create accounts
- All content is private by default
- Content is reviewed before delivery
- No social features
- No child-owned accounts
- Parents control all data and can delete accounts at any time

## Current Foundation Status

This is **MVP 0 — Design & Foundation**. The project has:

- [x] Next.js 16 App Router with TypeScript and Tailwind CSS v4
- [x] Cartoona design tokens (colors, spacing, components)
- [x] 29 placeholder routes (marketing, auth, dashboard, admin)
- [x] Marketing pages (homepage, characters, examples, pricing, safety, FAQ)
- [x] Auth route shells (login, signup, parent consent)
- [x] Parent dashboard route shells (10 pages)
- [x] Admin route shells (9 pages)
- [x] Draft database schema (12 tables)
- [x] Configuration files (characters, candy costs, plans, moderation)
- [x] Shared TypeScript types
- [x] Auth + RLS architecture plan (`docs/AUTH_RLS_PLAN.md`)
- [x] Project documentation + AGENTS.md guardrails
- [ ] **Supabase is not connected** — packages not installed
- [ ] **Auth is not implemented** — all routes are public
- [ ] **Storage is not configured**
- [ ] **Stripe is not configured**
- [ ] **API routes do not exist**
- [ ] **Tests are not configured**

## What Is Intentionally Not Built Yet

- AI image/video/animation generation
- Supabase connection (packages not installed)
- Full authentication / auth guards
- Stripe checkout or payment flows
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
- API routes
- Middleware or auth guards

The foundation is ready for **MVP 1 — Manual Request Platform** when directed.

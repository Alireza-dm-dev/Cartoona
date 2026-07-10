# Cartoona Architecture

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| UI Components | Custom (minimal shadcn/ui-compatible approach) |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| Storage | Supabase Storage |
| Payments | Stripe (future) |
| AI | API-agnostic provider adapters (future) |

## Folder Structure

```
app/
  (marketing)/     # Public marketing pages (no auth)
  (auth)/          # Auth pages (login, signup, consent)
  (dashboard)/     # Parent dashboard (requires auth)
  admin/           # Admin console (requires admin role)
components/
  ui/              # Reusable design-system components
  layout/          # Layout-specific components
  marketing/       # Marketing page components
  dashboard/       # Dashboard-specific components
  admin/           # Admin-specific components
  creation/        # Creation wizard components
  characters/      # Character display components
  pricing/         # Pricing page components
  safety/          # Safety/privacy components
lib/
  supabase/        # Supabase clients (client, server, admin)
  auth/            # Auth utilities
  permissions/     # Role-based permission helpers
  stripe/          # Stripe integration (future)
  ai/              # AI provider adapters (future)
  storage/         # Storage helpers
  candies/         # Candy ledger logic
  orders/          # Order business logic
  validators/      # Zod schemas (future)
  constants/       # App-wide constants
db/
  migrations/      # Supabase migrations
  seed/            # Seed data
  schema.sql       # Database schema reference
types/             # Shared TypeScript types
config/            # App configuration
docs/              # Project documentation
tests/             # Test files
```

## App Route Groups

- `(marketing)` — Public, no auth required. SEO-focused pages.
- `(auth)` — Public, thin layout. Handles login/signup/consent.
- `(dashboard)` — Parent-only. All routes require parent role. TODO: Add auth guard.
- `admin/` — Admin-only. All routes require admin/super_admin role. TODO: Add role guard.

## Data Model Summary

| Entity | Purpose |
|---|---|
| `users` | App-level user roles (extends Supabase Auth) |
| `parent_profiles` | Parent-specific data + consent tracking |
| `child_profiles` | Optional child profiles (parent-owned) |
| `characters` | Original character catalog |
| `orders` | Core request table — all creation types |
| `media_assets` | Uploaded/generated files linked to orders |
| `candy_wallets` | Per-parent candy balance |
| `candy_transactions` | Immutable candy ledger |
| `video_requests` | Extended data for video orders |
| `drawing_animation_requests` | Extended data for drawing animation orders |
| `moderation_logs` | Moderation action history |
| `audit_logs` | Immutable audit trail |

## Supabase Strategy

- Use Supabase for database, auth, and storage.
- Three clients:
  - `lib/supabase/client.ts` — Browser-side client (anon key only).
  - `lib/supabase/server.ts` — Server-side client for SSR.
  - `lib/supabase/admin.ts` — Admin client with service role key (server only).
- RLS policies secure all tables. Never expose service role to client.
- Schema is managed via migrations in `db/migrations/`.

## Storage Strategy

- Private bucket for parent uploads (parent can read/write own).
- Private bucket for generated media (admin write, parent read).
- Public bucket for character assets (public read).
- TODO: Configure storage buckets and RLS policies.

## Auth/Permission Strategy

- Supabase Auth for authentication.
- Custom `user.role` column for application-level authorization.
- Roles: `guest` → `parent` → `admin` → `super_admin`.
- Route protection via middleware or layout-level checks.
- API routes check permissions before returning data.

## API Strategy

- Next.js API routes (`app/api/`) for server-side logic.
- Supabase client on server for direct database access.
- Admin operations use service role client.
- Public endpoints are rate-limited and validated.

## Auth + RLS Plan

See `docs/AUTH_RLS_PLAN.md` for the detailed architecture plan covering:
- Supabase Auth integration with `auth.users` → `public.users` linking
- Role strategy (`guest`, `parent`, `admin`, `super_admin`)
- Route protection layers (middleware → layout → RLS)
- Per-table RLS policy intentions
- Storage bucket access rules
- Implementation phases

## Security Principles

1. Never expose service role key to client.
2. Validate all input on server side.
3. RLS on every table — fail closed.
4. Audit sensitive operations.
5. Rate limit auth endpoints.
6. Sanitize all user-generated content.
7. Parent consent required for child-related operations.

# Supabase Setup Guide

> Use this guide to create a Supabase project and connect it to your local Cartoona development environment.
> **Do not run any of these steps against a production project.** This guide is for local/development setup only.

---

## Prerequisites

- Node.js and npm installed
- Cartoona project cloned and `npm install` completed
- A [Supabase](https://supabase.com) account (free tier is sufficient)

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
3. Enter a name (e.g., `cartoona-dev`).
4. Set a secure database password and save it somewhere safe (you won't need it often).
5. Choose a region close to you.
6. Click **Create new project**.
7. Wait ~2 minutes for the project to provision.

---

## Step 2: Get Your API Credentials

1. In the Supabase Dashboard, go to **Project Settings** > **API**.
2. Find these three values:

   | Variable | Where to find it |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | **Project URL** — looks like `https://abc123.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **anon public** key — starts with `eyJ...` |
   | `SUPABASE_SERVICE_ROLE_KEY` | **service_role** key — starts with `eyJ...` (keep secret!) |

3. Copy these values into `.env.local` (based on `.env.local.example`).

---

## Step 3: Configure Auth Settings

Before signup/login will work:

1. Go to **Authentication** > **Providers** and ensure **Email** is enabled.
2. Go to **Authentication** > **Settings**:
   - Set **Site URL** to `http://localhost:3000`
   - Disable **Confirm email** during development (optional, but convenient)
   - Add `http://localhost:3000` to **Redirect URLs**

> **Note:** These settings are for development only. In production, require email confirmation and use your production URL.

---

## Step 4: Apply the Schema

The project has a draft schema that creates all 12 public tables.

### Option A: Supabase SQL Editor (easiest)

1. Go to **SQL Editor** in the Supabase Dashboard.
2. Open `db/schema.sql` from this project.
3. Copy the entire file contents into the SQL Editor.
4. Click **Run** — all 12 tables are created.

### Option B: PSQL CLI

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

---

## Step 5: Apply Migrations in Order

Each migration file in `supabase/migrations/` makes a specific, reversible change to the schema.

| Order | File | Purpose | Run after |
|---|---|---|---|
| 1 | `supabase/migrations/20260712090001_link_auth_users.sql` | Links `public.users.id` to `auth.users.id`, adds `handle_new_user` trigger | Schema applied |
| 2 | `supabase/migrations/20260712090002_rls_helpers.sql` | Creates SECURITY DEFINER helper functions for RLS policies | Migration 00001 |
| 3 | `supabase/migrations/20260712090003_ownership_indexes.sql` | Adds indexes on foreign-key columns used in ownership policies | Migrations 00001–00002 |
| 4 | `supabase/migrations/20260712090004_rls_policies_users_profiles_characters.sql` | Enables RLS and adds policies on `users`, `parent_profiles`, `characters` | Migrations 00001–00003 |

### How to apply

**SQL Editor method (one file at a time):**

Open each migration file in order, copy the contents into the SQL Editor, and click **Run**.

**PSQL CLI method:**

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260712090001_link_auth_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260712090002_rls_helpers.sql
psql "$DATABASE_URL" -f supabase/migrations/20260712090003_ownership_indexes.sql
psql "$DATABASE_URL" -f supabase/migrations/20260712090004_rls_policies_users_profiles_characters.sql
```

### Verify

After applying all migrations, run this query in the SQL Editor to confirm RLS is enabled:

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('users', 'parent_profiles', 'characters');
```

Result should show `rowsecurity = true` for all three tables.

---

## Step 6: Verify the Setup

1. Confirm your `.env.local` has the correct values:

```bash
node -e "
const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
if (!env.url || !env.key) { console.error('Missing Supabase credentials'); process.exit(1); }
console.log('Supabase URL:', env.url);
console.log('Anon key present:', !!env.key);
"
```

2. Build the project:

```bash
npm run build
```

3. Start the dev server:

```bash
npm run dev
```

All placeholder pages should render. The demo auth system (phone + code `11111`) continues to work — real Supabase Auth is not yet wired in.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: Missing NEXT_PUBLIC_SUPABASE_URL` | `.env.local` missing or incomplete | Copy `.env.local.example` to `.env.local` and fill in values |
| Build fails with Supabase type errors | Supabase packages not installed | Run `npm install` |
| SQL Editor shows "relation does not exist" | Schema not applied yet | Run `db/schema.sql` first, then migrations in order |
| RLS policy creation fails with "function does not exist" | Migrations applied out of order | Drop and re-apply in order: 00001 → 00002 → 00003 → 00004 |
| "TypeError: supabase.auth.signUp is not a function" | Real Supabase Auth not wired yet | Expected — demo auth is still active. See `docs/AUTH_RLS_PLAN.md` |

---

## Next Steps After Setup

Once Supabase is connected and the schema is applied:

1. Read `docs/AUTH_RLS_PLAN.md` to understand the auth architecture.
2. When ready to replace demo auth, wire the Supabase server client into `middleware.ts`.
3. Wire the browser client into `app/(auth)/login/page.tsx`.
4. Apply the remaining RLS policies (migrations 00005+ for `child_profiles`, `orders`, etc.).
5. Add storage buckets and policies.

These steps are **future work** — do not attempt them until guided.

---

## Security Notes

- Never commit `.env.local` or real credentials to version control.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses all RLS — use it only in server-only code.
- An admin/service-role client will be added later when API routes need it.
- All anon-key clients enforce RLS — test RLS policies before considering them secure.

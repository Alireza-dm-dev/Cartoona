# Auth + RLS Architecture Plan

> **Status:** Planning document. Not implemented. Supabase packages not installed.
> **See also:** `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `db/schema.sql`

---

## 1. Auth Model

### Core approach
- **Supabase Auth** manages real authenticated users through `auth.users` (built-in Supabase table).
- Cartoona app profile data lives in **public app tables** linked to `auth.users.id`.
- The `public.users` table in the draft schema serves as the app-level profile + role store.
- `auth.users` handles authentication (password, magic link, OAuth). `public.users` handles authorization (role, consent, profile metadata).

### Parent-first constraint
- Parent users are the primary account holders. Signup creates both an `auth.users` row and a `public.users` row.
- Children must not have independent accounts in MVP. Child profiles are sub-resources under the parent.
- Admin and super_admin roles must be assigned server-side only, never self-assigned.

### Auth flow summary (future)
```
User signs up
  → Supabase Auth creates auth.users row
  → Database trigger or edge function creates public.users row
  → Parent profile created
  → Redirect to dashboard

User logs in
  → Supabase Auth validates credentials
  → Server client reads session cookie
  → Application checks public.users.role for authorization
```

---

## 2. User/Profile Table Recommendation

### Current schema (`db/schema.sql`)

```sql
CREATE TABLE public.users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'parent',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
```

### Issue
`public.users.id` uses `gen_random_uuid()` — it generates its own UUID. This creates two problems:
1. No link to `auth.users.id`. The app user row is disconnected from the auth identity.
2. `parent_profiles.user_id` references `public.users.id`, so the chain is `auth.users` → (broken) → `public.users` → `parent_profiles`.

### Recommendation

**Revise `public.users` to use `auth.users.id` as its primary key:**

```sql
CREATE TABLE public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'parent' CHECK (role IN ('parent', 'admin', 'super_admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
```

Changes:
- `id` becomes `auth.users.id` reference (no default, must match the Supabase auth ID).
- Remove `guest` from CHECK — guest is an unauthenticated state, not a DB row.
- `email` can be synced from `auth.users.email` via trigger.
- A trigger on `auth.users` after insert creates the `public.users` row automatically.

### Table naming
Keep `public.users` as the app profile/roles table. Do not rename — it is clear and matches the plural convention of other tables. The `auth.users` reference is unambiguous.

### Chain after revision
```
auth.users (Supabase, auth provider)
  └── public.users (app profile, linked by id)
        └── public.parent_profiles (linked by user_id)
              ├── public.child_profiles (linked by parent_id)
              ├── public.orders (linked by parent_id)
              ├── public.candy_wallets (linked by parent_id)
              └── ...
```

---

## 3. Role Strategy

| Role | Stored in DB | Description |
|---|---|---|
| `guest` | No | Unauthenticated visitor. Not a DB row. |
| `parent` | Yes, `public.users.role` | Default role on signup. Can create requests, manage own data. |
| `admin` | Yes, `public.users.role` | Can view queues, fulfill requests, moderate content. |
| `super_admin` | Yes, `public.users.role` | Full access. Can assign admin roles, manage platform settings. |

### Rules
1. **`guest` is never stored.** It's the absence of authentication.
2. **`parent` is the default.** All new signups get this role.
3. **`admin`/`super_admin` are never self-assignable.** Role escalation requires server-side action (Supabase dashboard, edge function, or admin API).
4. **Client-side role escalation protection.** The browser client (anon key) cannot modify `public.users.role` — RLS prevents it. Only the service-role client can write to `role`.
5. **RLS enforces role-based access.** Even if a client somehow guesses an admin ID, RLS blocks unauthorized reads/writes.

---

## 4. Route Protection Strategy

### Route groups and their protection levels

#### Public (no auth required)
| Route | Notes |
|---|---|
| `/` | Marketing homepage |
| `/characters` | Public character catalog |
| `/examples` | Fictional examples |
| `/pricing` | Pricing info |
| `/safety` | Safety/privacy |
| `/faq` | FAQ |
| `/login` | Auth page (public) |
| `/signup` | Auth page (public) |
| `/parent-consent` | Consent info page (public) |

#### Parent-protected (requires `parent`, `admin`, or `super_admin`)
| Route | Notes |
|---|---|
| `/dashboard/*` | All dashboard routes require authenticated parent role |

#### Admin-protected (requires `admin` or `super_admin`)
| Route | Notes |
|---|---|
| `/admin/*` | All admin routes require admin or super_admin role |

### Layered protection approach

Recommended: Use **three layers** of protection, not just one.

#### Layer 1: Middleware (navigation-level)
- Next.js middleware checks session + role for route groups.
- Redirects unauthenticated users to `/login`.
- Redirects non-admin users away from `/admin/*`.
- Fast, coarse-grained: stops unauthorized users before they see any protected content.

#### Layer 2: Server layout/component checks (app-level)
- Each protected layout checks the session server-side.
- If session is missing or role is insufficient, redirect or show an error.
- Catches cases where middleware might not apply (e.g., dynamic route segments, edge cases).

#### Layer 3: RLS (database-level)
- Every query runs through RLS.
- Even if middleware or layout checks fail, RLS prevents data access.
- This is the final safety net.

### Implementation notes
- Middleware is suitable for route-group-level redirects. Do not put per-record authorization in middleware.
- Per-record authorization belongs in RLS and API route checks.
- Static pages that display user-specific data must use server components or client-side data fetching with RLS.

---

## 5. Supabase Client Architecture

### `lib/supabase/client.ts` — Browser client
- Uses `NEXT_PUBLIC_SUPABASE_ANON_KEY` only.
- Created via `createBrowserClient()` from `@supabase/ssr`.
- Used in client components for authenticated data fetching.
- **Never imports `SUPABASE_SERVICE_ROLE_KEY`.**
- Current stub: throws with clear error until packages are installed.

### `lib/supabase/server.ts` — Server-side SSR client
- Uses cookie-based auth for server components and route handlers.
- Created via `createServerClient()` from `@supabase/ssr`.
- Reads session from cookies, makes authenticated requests on behalf of the user.
- **Never uses the service role key** — operates as the logged-in user.
- Current stub: throws with clear error until packages are installed.

### `lib/supabase/admin.ts` — Admin/service-role client
- Uses `SUPABASE_SERVICE_ROLE_KEY` directly.
- Created via `createClient()` from `@supabase/supabase-js`.
- **Server-only.** Must never be imported in client components or pages.
- Used for admin operations, user management, seed scripts, and tasks that bypass RLS.
- Current stub: throws with clear error until packages are installed.

### Security rules
- Service-role key goes in `.env.local` only, never in `.env` or client code.
- No file in `lib/supabase/admin.ts` may be imported by any `"use client"` component or page file.
- Consider adding an ESLint rule or a barrel export pattern that separates server-only utilities.

---

## 6. RLS Policy Plan

### Table-by-table policy intentions

#### `public.users`
| Action | Who can do it | Policy |
|---|---|---|
| SELECT own row | Authenticated user | `auth.uid() = id` |
| SELECT any row | Admin, super_admin | `role IN ('admin', 'super_admin')` |
| INSERT | Service role only (trigger from `auth.users`) | No direct INSERT from app |
| UPDATE own row | Authenticated user (limited fields) | `auth.uid() = id` — restrict role changes |
| UPDATE role | Service role only | RLS blocks role changes from app |
| DELETE | Service role only (cascade from `auth.users`) | No direct DELETE from app |

#### `public.parent_profiles`
| Action | Who | Policy |
|---|---|---|
| SELECT own | Parent | `user_id = auth.uid()` |
| SELECT any | Admin, super_admin | `auth.uid()` with role check via `public.users` |
| INSERT | Service role (on signup) | No direct INSERT from app |
| UPDATE own | Parent (limited fields) | `user_id = auth.uid()` |
| DELETE | Service role (cascade) | No direct DELETE |

#### `public.child_profiles`
| Action | Who | Policy |
|---|---|---|
| SELECT/CREATE/UPDATE/DELETE own children | Parent | `parent_id` matches own `parent_profiles.id` |
| SELECT/UPDATE any | Admin, super_admin | Role check |
| DELETE own | Parent | Own parent record |

#### `public.characters`
| Action | Who | Policy |
|---|---|---|
| SELECT | Anyone (public) | `is_active = true` |
| INSERT/UPDATE/DELETE | Admin, super_admin | Role check |

#### `public.orders`
| Action | Who | Policy |
|---|---|---|
| SELECT own | Parent | `parent_id` matches own `parent_profiles.id` |
| CREATE own | Parent | `parent_id` forced to own `parent_profiles.id` |
| UPDATE own | Parent (limited: cancel, update description) | `parent_id` match; restrict status changes |
| SELECT/UPDATE any | Admin, super_admin | Role check; admin can update status/assign |

#### `public.media_assets`
| Action | Who | Policy |
|---|---|---|
| SELECT | Parent (own orders) | Via join to `orders` where `parent_id` matches |
| SELECT/INSERT | Admin, super_admin | Role check |
| UPDATE moderation_status | Admin, super_admin | Role check |
| No direct parent INSERT | — | Media uploaded by admin or service role |

#### `public.candy_wallets`
| Action | Who | Policy |
|---|---|---|
| SELECT own | Parent | `parent_id` matches own profile |
| SELECT any | Admin, super_admin | Role check |
| UPDATE | Service role only | No direct app writes to balance |

#### `public.candy_transactions`
| Action | Who | Policy |
|---|---|---|
| SELECT own | Parent | Via `wallet_id` → own wallet |
| SELECT any | Admin, super_admin | Role check |
| INSERT | Service role only | Immutable ledger written server-side |

#### `public.video_requests`
| Action | Who | Policy |
|---|---|---|
| SELECT own | Parent | Via `order_id` → own `orders` |
| SELECT/UPDATE any | Admin, super_admin | Role check |
| INSERT/CREATE | Parent (via order) | Business logic handles this |

#### `public.drawing_animation_requests`
| Action | Who | Policy |
|---|---|---|
| SELECT own | Parent | Via `order_id` → own `orders` |
| SELECT/UPDATE any | Admin, super_admin | Role check |

#### `public.moderation_logs`
| Action | Who | Policy |
|---|---|---|
| SELECT/INSERT | Admin, super_admin | Role check |
| No parent access | — | Parents never see moderation logs |

#### `public.audit_logs`
| Action | Who | Policy |
|---|---|---|
| SELECT | Super_admin only | Strict role check |
| No parent access | — | Parents never see audit logs |

---

## 7. Storage Access Plan

### Buckets

| Bucket | Visibility | Purpose |
|---|---|---|
| `child-photos` | Private | Parent-uploaded child photos for character personalization |
| `drawings` | Private | Uploaded child drawings for animation requests |
| `generated-images` | Private | AI/ manually generated cartoon images |
| `final-videos` | Private | Completed cartoon videos |
| `thumbnails` | Private | Preview thumbnails |
| `character-assets` | Public | Official character artwork (publicly readable) |

### Access rules
- **Buckets are private by default.** Only `character-assets` is public.
- **Parent access** to private buckets is through ownership checks — parent can only access files linked to their own orders.
- **Signed URLs** for download/preview — never expose direct storage URLs for private content.
- **Admin access** via server-side checks — admins can upload/review files for any order.
- **No public child media** in MVP. No file in `child-photos` or `drawings` is publicly accessible.
- **Service role** for admin upload operations (bypasses RLS on storage).

---

## 8. Signup/Onboarding Plan

### Future flow (not implemented)

1. Parent visits `/signup`.
2. Fills in email, password, name, accepts consent.
3. Supabase Auth creates `auth.users` row.
4. Database trigger or edge function:
   - Creates `public.users` row (id = `auth.users.id`, role = `parent`).
   - Creates `public.parent_profiles` row with consent timestamp.
   - Creates `public.candy_wallets` row with starter candies (e.g., 10 free candies).
5. User is redirected to `/dashboard`.
6. Email verification and magic link are **deferred** — password-based signup first.

### Consent handling
- Consent checkbox must be explicitly checked before signup.
- `parent_profiles.consent_granted` is set to `true` with timestamp.
- Consent version recorded for audit (simple integer field: `consent_version`).

### Starter candy grant
- Handled by a database function, not client code.
- `candy_wallets` initialized with a small starter balance (configurable via `config/candy-costs.ts`).
- Initial grant recorded as a `candy_transactions` row of type `grant`.

---

## 9. Admin Assignment and Role-Management Plan

### How admins are created
- Not from public signup. No "register as admin" option.
- Super admin uses Supabase Dashboard or an admin-only API to change a user's role.
- Future: A secure admin settings page that only `super_admin` can access, with audit logging.

### Why admin creation is restricted
- Self-serve admin accounts create a massive security risk.
- Admin role grants access to all user data, order queues, and moderation tools.
- RLS prevents client-side role escalation, but the application should never offer the option.

### How super_admin manages admins
- Future: `/admin/users` page shows a list of users.
- Super admin can promote a `parent` to `admin`, or demote `admin` to `parent`.
- Only `super_admin` can change `admin` or `super_admin` roles.
- Role change triggers an audit log entry.

### Audit logging for role changes
- Every role change inserts an `audit_logs` row:
  ```
  actor_id: super_admin's user ID
  action: 'role_change'
  target_type: 'user'
  target_id: the user whose role changed
  metadata: { from_role: 'parent', to_role: 'admin' }
  ```

---

## 10. Schema Risks and TODOs

### Risks found in current `db/schema.sql`

| Risk | Impact | Recommended fix (future) |
|---|---|---|
| `public.users.id` uses `gen_random_uuid()` instead of `auth.users.id` | No link to Supabase Auth identity. Two disconnected user records. | Change PK to `UUID REFERENCES auth.users(id)` |
| `guest` included in role CHECK | `guest` is not a DB-stored role; creates confusion | Remove `guest` from CHECK; role defaults to `parent` |
| No `auth.users` reference comment on FK chain | Future implementer might not understand the two-table model | Add comment on `public.users.id` |
| No indexes on foreign keys | Performance degrades as tables grow | Add indexes on all `_id` columns, `status`, `created_at` |
| No RLS policies applied | All tables publicly accessible | Add all policies documented in section 6 |
| No soft-delete policy documented | `deleted_at` exists on `public.users` but no retention/cleanup plan | Document soft-delete retention (e.g., 30 days before permanent delete) |
| `moderation_logs` and `audit_logs` have `UUID` for `target_id` but no FK constraint | Can reference any table; no referential integrity | Add FK constraints or accept loose coupling (audit tables track any entity) |
| `candy_transactions` has no `CHECK` preventing negative `amount` except for `spend` type | Positive amounts on `spend` type would be a logic error | Add `CHECK` constraints per transaction type |
| No trigger for `updated_at` | Columns exist but are never auto-updated | Add `updated_at` trigger function and apply to all mutable tables |
| `child_profiles.favorite_character_id` has no FK | Orphaned character references possible | Add `REFERENCES public.characters(id)` |
| `media_assets` lacks `updated_at` | Intentional (immutable) but worth documenting | Add comment explaining immutability |
| No storage bucket RLS documented | Storage access not planned | Add storage RLS policies matching section 7 |

### Child privacy concerns
- `child_profiles` stores `name` and `birth_year` — sensitive PII.
- RLS must ensure only the owning parent can access these fields.
- No child data should ever appear in public queries.
- Future: Consider encryption at rest for child PII columns.

---

## 11. Recommended Implementation Phases

### Phase A: Install Supabase packages
- Install `@supabase/supabase-js` and `@supabase/ssr`.
- Replace `lib/supabase/*.ts` stubs with real clients.
- Set up `.env.local` with actual Supabase project credentials.
- Verify clients work in dev.

### Phase B: Schema revision for auth.users linking
- Revise `public.users` PK to `UUID REFERENCES auth.users(id)`.
- Remove `guest` from role CHECK.
- Create trigger function on `auth.users` to auto-create `public.users` row.
- Create trigger function to sync `auth.users.email` to `public.users.email`.
- Update `types/database.ts` to match.

### Phase C: RLS policies and indexes
- Apply RLS policies from section 6 to all 12 tables.
- Add indexes on foreign keys, status columns, `created_at`.
- Add `updated_at` trigger function.
- Test policies in Supabase SQL editor.

### Phase D: Signup/login/logout
- Build signup form (email, password, name, consent checkbox).
- Build login form.
- Build logout button.
- Wire up Supabase Auth calls.
- Test full auth flow.

### Phase E: Parent route protection
- Create middleware that checks session for `(dashboard)` routes.
- Create helper function `requireParent()` for layout checks.
- Update dashboard layout to verify parent role.
- Redirect unauthenticated users to `/login`.

### Phase F: Admin route protection
- Create middleware check for `/admin/*` routes.
- Create helper function `requireAdmin()` for layout checks.
- Update admin layout to verify admin/super_admin role.
- Redirect unauthorized users to `/dashboard`.

### Phase G: First protected dashboard read
- Fetch `parent_profiles` data from Supabase on dashboard page.
- Display real parent name and consent status.
- Verify RLS allows parent to read own data only.

### Phase H: First secure order creation (later)
- Create order form that inserts into `orders` table.
- Verify RLS enforces `parent_id` = own profile.
- Verify admin can see all orders.

---

## 12. Design Decisions Summary

| Decision | Rationale |
|---|---|
| `public.users.id` references `auth.users.id` | Single identity source; no duplicate user records; enables CASCADE delete |
| `guest` is not stored | Unauthenticated state is implied by absence of session, not a DB row |
| Role stored in `public.users.role`, not Supabase metadata | Easier RLS integration, custom CHECK constraints, no sync issues |
| Three-layer protection (middleware → layout → RLS) | Defense in depth; middleware for UX, RLS as safety net |
| Stubs throw errors instead of returning null | Fast failure with clear message prevents silent broken behavior |
| Private buckets by default | Child safety and privacy; no accidental public exposure |
| Signed URLs for downloads | Access control on individual files without making buckets public |
| Starter candies via DB function, not client | Atomic, auditable, non-replayable |

---

## Appendix: Supabase Clients Quick Reference

| File | Imported in | Key used | Purpose |
|---|---|---|---|
| `lib/supabase/client.ts` | Client components | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser-side data fetching |
| `lib/supabase/server.ts` | Server components, layouts | Cookie session (anon key) | SSR auth, route handlers |
| `lib/supabase/admin.ts` | API routes, scripts, seed | `SUPABASE_SERVICE_ROLE_KEY` | Admin ops, bypass RLS |

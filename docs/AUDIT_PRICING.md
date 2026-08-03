# Cartoona Creation-Pricing Audit

> Audit date: 2026-07-27
> Read-only — no files modified.
>
> **Resolution (2026-07-27):** Task C completed. `config/candy-costs.ts` deleted.
> Numeric pricing authority is now exclusively in `public.creation_pricing` (database).
> TypeScript defines only stable pricing-key types in `lib/pricing/pricing-keys.ts`.
> UI loads catalog via `GET /api/creation-pricing` and the `useCreationPricing()` hook.
> Cost calculation is done via `calculateCreationCost()` from the loaded catalog.
> Draft-stored `estimatedCandyCost` is overwritten with catalog-derived value.
> `request-submission.ts` no longer computes `expectedCandyCost`.
> The RPC (`create_parent_request`) remains the sole financial authority.
>
> **Security update (2026-07-31):** `create_parent_request` is no longer callable by
> browser-authenticated roles. The financial authority is now the server-only
> `create_parent_request_trusted(p_parent_profile_id, ...)` RPC, callable only by
> `service_role` (migration `20260731100000_restrict_parent_request_creation.sql`).
> Pricing resolution inside the trusted RPC is unchanged (exclusive catalog lookup).

---

## 1. Files Inspected

### Database
- `supabase/migrations/20260717220001_create_parent_request_rpc.sql` — original RPC (396 lines)
- `supabase/migrations/20260726110000_atomic_request_candy_debit.sql` — replaced RPC with wallet deduction (463 lines)
- `supabase/migrations/20260726100000_harden_candy_wallet_ledger.sql` — wallet/ledger hardening
- `supabase/migrations/20260717220000_order_request_read_rls.sql` — RLS setup
- `db/schema.sql` — schema documentation (348 lines)

### TypeScript Configuration
- `config/candy-costs.ts` — candy cost constants + 3 calculator functions (73 lines)
- `config/plans.ts` — plan definitions (67 lines)
- `config/characters.ts` — character catalog (69 lines)
- `config/admin.ts` — order type → Persian labels (8 lines)
- `config/moderation-rules.ts` — moderation categories (20 lines)
- `config/showcase.ts` — example gallery style map (9 lines)

### Request Submission
- `app/api/requests/route.ts` — POST handler, calls RPC (185 lines)
- `lib/requests/request-submission.ts` — draft validation, computes `expectedCandyCost` (196 lines)
- `lib/creation/creation-draft.ts` — draft types, sessionStorage helpers (81 lines)

### Types
- `types/database.ts` — DB row types, RPC params/result, error codes (203 lines)
- `types/app.ts` — domain union types (22 lines)

### Active Creation Pages (multi-step, full interactive)
- `app/(creation)/create-image/page.tsx` — 3-step form, uses `calculateImageCandyCost` (454 lines)
- `app/(creation)/request-video/page.tsx` — 3-step form, uses `calculateVideoCandyCost` (505 lines)
- `app/(creation)/animate-drawing/page.tsx` — 3-step form, uses `calculateDrawingAnimationCandyCost` (477 lines)

### Dashboard Stub Pages (disabled, placeholder)
- `app/(dashboard)/dashboard/create-image/page.tsx` — stub with placeholder cost (154 lines)
- `app/(dashboard)/dashboard/request-video/page.tsx` — stub with placeholder cost (147 lines)
- `app/(dashboard)/dashboard/animate-drawing/page.tsx` — stub with placeholder cost (164 lines)
- `app/(dashboard)/dashboard/billing/page.tsx` — placeholder billing page (23 lines)
- `app/(dashboard)/dashboard/page.tsx` — dashboard with mock recent requests (203 lines)
- `app/(dashboard)/dashboard/orders/page.tsx` — mock order list (167 lines)
- `app/(dashboard)/dashboard/orders/[orderId]/page.tsx` — mock order detail

### Creation Components
- `components/creation/pending-creation-draft-card.tsx` — reads draft, displays `estimatedCandyCost` (174 lines)
- `components/creation/complete-creation-request.tsx` — completion page with file re-selection (233 lines)
- `components/ui/candy-balance-badge.tsx` — badge for balance display (16 lines)

### Creation Entry Points
- `app/(creation)/complete-request/page.tsx` — auth-gated page, renders `<CompleteCreationRequest>` (63 lines)
- `app/(marketing)/pricing/page.tsx` — plan pricing page, uses `config/plans.ts` (124 lines)
- `app/(marketing)/page.tsx` — landing page, three creation-type cards (212 lines)

### Admin Pages
- `app/admin/settings/page.tsx` — placeholder with "تنظیمات آبنبات و قیمت‌گذاری" heading (65 lines)
- `app/admin/candy-ledger/page.tsx` — mock transaction list (225 lines)
- `app/admin/requests/page.tsx` — mock requests with `candyCost` (141 lines)
- `app/admin/requests/[requestId]/page.tsx` — mock request detail with `candyCost` (265 lines)

### Tests
- `tests/e2e/login-destinations.spec.ts` — Playwright login redirect tests, no candy-cost assertions

### Documentation
- `.claude/summary.md` — session summary
- `docs/ARCHITECTURE.md` — architecture overview (130 lines)
- `docs/FEATURES.md` — feature checklists (106 lines)
- `docs/ROADMAP.md` — roadmap (76 lines)
- `docs/DECISIONS.md` — architecture decision records (139 lines)

---

## 2. Complete SQL Price Matrix

Every creation variant priced inside `create_parent_request` (both original and replaced RPC — identical pricing):

| Request Type | Duration Key | Has Source File | SQL Candy Cost | File | Lines |
|-------------|-------------|----------------|---------------|------|-------|
| `image` | N/A (must be NULL) | no | 12 | `20260726110000_atomic_request_candy_debit.sql` | 281–284 |
| `image` | N/A (must be NULL) | yes | 15 (12+3) | same | 281–284 |
| `video` | `short` | no | 40 | same | 287–295 |
| `video` | `medium` | no | 60 | same | 287–295 |
| `video` | `long` | no | 90 | same | 287–295 |
| `video` | `short` | yes | 45 (40+5) | same | 287–295 |
| `video` | `medium` | yes | 65 (60+5) | same | 287–295 |
| `video` | `long` | yes | 95 (90+5) | same | 287–295 |
| `drawing_animation` | `short` | N/A (always required) | 35 | same | 297–304 |
| `drawing_animation` | `medium` | N/A (always required) | 50 | same | 297–304 |
| `drawing_animation` | `long` | N/A (always required) | 75 | same | 297–304 |

### Notes
- `drawing_animation` cannot have a source file surcharge because `v_has_file` is always true (the RPC requires a file for this type), but the SQL does NOT add the +5 surcharge for drawing — only image and video have the reference-file surcharge.
- Image refuses `duration_key` (raises `request_duration_not_allowed`).
- No rounding occurs anywhere; all values are integer literals.
- The same computed `v_candy_cost` is used for: `orders.candy_cost`, wallet deduction (`balance - v_candy_cost`), and `candy_transactions.amount` (`-v_candy_cost`).
- No client-supplied value can influence cost; the RPC recalculates entirely server-side from the type + option parameters.

---

## 3. Complete TypeScript Price Matrix

Defined in `config/candy-costs.ts`:

| Request Type | Condition | TS Candy Cost | Source Expression | Line |
|-------------|----------|---------------|-------------------|------|
| `image` | no reference file | 12 | `candyCosts.image.base` | 19–23 |
| `image` | with reference file | 15 | `base + candyCosts.image.referenceFile` | 53–58 |
| `video` | `"کوتاه"` (short), no ref file | 40 | `candyCosts.video.duration.short` | 24–31 |
| `video` | `"متوسط"` (medium), no ref file | 60 | `candyCosts.video.duration.medium` | 24–31 |
| `video` | `"بلند"` (long), no ref file | 90 | `candyCosts.video.duration.long` | 24–31 |
| `video` | short + ref file | 45 | short + `candyCosts.video.referenceFile` | 61–68 |
| `video` | medium + ref file | 65 | medium + `referenceFile` | 61–68 |
| `video` | long + ref file | 95 | long + `referenceFile` | 61–68 |
| `drawing` | `"کوتاه"` (short) | 35 | `candyCosts.drawingAnimation.duration.short` | 31–38 |
| `drawing` | `"متوسط"` (medium) | 50 | `candyCosts.drawingAnimation.duration.medium` | 31–38 |
| `drawing` | `"بلند"` (long) | 75 | `candyCosts.drawingAnimation.duration.long` | 31–38 |

### Matching Check: SQL vs TypeScript

**All 11 variants match exactly between SQL and TypeScript.** No mismatch.

However, the way drawing animation format durations are mapped differs:
- In SQL: `p_duration_key` is already `"short"|"medium"|"long"` (internal key)
- In TS: `FormDuration` is Persian `"کوتاه"|"متوسط"|"بلند"`, mapped via `formToDrawingAnimationDuration` map

---

## 4. Complete UI-Displayed Candy Cost Matrix

### Pre-auth creation pages (live, `app/(creation)/`)

| Page | Cost Displayed | Source | Data Type |
|------|---------------|--------|-----------|
| `create-image/page.tsx` | `estimatedCost.toLocaleString("fa-IR") آب‌نبات` | `calculateImageCandyCost()` at line 41 | Calculated live from TS constant |
| `request-video/page.tsx` | `estimatedCost.toLocaleString("fa-IR") آب‌نبات` | `calculateVideoCandyCost()` at lines 48–53 | Calculated live from TS constant |
| `animate-drawing/page.tsx` | `estimatedCost.toLocaleString("fa-IR") آب‌نبات` | `calculateDrawingAnimationCandyCost()` at lines 42–44 | Calculated live from TS constant |

All three display `"هزینه برآوردی"` (estimated cost) and say `"این هزینه برآوردی است و هزینه نهایی پیش از ثبت درخواست تأیید می‌شود."`

### Draft summary card (`pending-creation-draft-card.tsx`)

| Field | Display | Source |
|-------|---------|--------|
| Estimated cost | `draft.estimatedCandyCost.toLocaleString("fa-IR") آب‌نبات` | `CreationDraftBase.estimatedCandyCost` (from sessionStorage) |

### Dashboard stub pages (`app/(dashboard)/dashboard/`)

| Page | Cost Displayed | Data Type |
|------|---------------|-----------|
| `create-image/page.tsx:123–132` | `"—"` + placeholders | Placeholder (no real cost) |
| `request-video/page.tsx:113–122` | `"—"` + placeholders | Placeholder (no real cost) |
| `animate-drawing/page.tsx:130–139` | `"—"` + placeholders | Placeholder (no real cost) |

### Dashboard home (`dashboard/page.tsx`)

| Field | Display | Data Type |
|-------|---------|-----------|
| 4 mock recent requests | candyCost: 15, 45, 30, 45 | Mock/hardcoded |
| Quick action buttons | No cost shown | N/A |

### Dashboard orders (`dashboard/orders/page.tsx`)

| Field | Display | Data Type |
|-------|---------|-----------|
| 5 mock orders | candyCost: 150, 500, 300, 75, 500 | Mock/hardcoded — these do NOT match real prices |
| Summary card | "—" for total candies spent | Placeholder |

### Dashboard billing (`dashboard/billing/page.tsx`)

| Content | Data Type |
|---------|-----------|
| "Billing & Wallet" + "Manage your Candy balance" + "Wallet not yet active" | Placeholder (English) |

### Pricing page (`(marketing)/pricing/page.tsx`)

| Content | Source | Data Type |
|---------|--------|-----------|
| 4 plan prices in Toman + candy counts | `config/plans.ts` | Real configuration |
| "آب‌نبات چگونه استفاده می‌شود?" explanation | Hardcoded | Informational |
| Disclaimer: payment not active | Hardcoded | Informational |

### Admin pages

| Page | Cost Displayed | Data Type |
|------|---------------|-----------|
| `admin/requests/page.tsx` | 8 mock requests: candyCost 15, 45, 30, 45, 75, 15, 90, 30 | Mock — does not match real prices |
| `admin/requests/[requestId]/page.tsx` | candyCost 15 (image), 30 (drawing) | Mock |
| `admin/candy-ledger/page.tsx` | Mock amounts: +500, -200, +1000, -350, etc. | Mock |
| `admin/settings/page.tsx` | Heading only: "تنظیمات آبنبات و قیمت‌گذاری" | Placeholder |

---

## 5. Every Mismatch Found

| # | Location | Issue | Severity |
|---|----------|-------|----------|
| 1 | **SQL ↔ TS** | Costs match exactly in all 11 variants | ✅ No mismatch |
| 2 | `dashboard/orders/page.tsx` mock (150, 500, 300, 75) | Does not match real prices (image=12, video=40/60/90, drawing=35/50/75) | Low (mock data) |
| 3 | `dashboard/page.tsx` mock (15, 45, 30, 45) | 15 is close to image+file (12+3=15); 45 is close to video+file short (40+5=45); 30 is close to drawing short (35) — approximate but not exact | Low (mock data) |
| 4 | `admin/requests/page.tsx` mock (15, 45, 30, 45, 75, 15, 90, 30) | Similar approximate numbers | Low (mock data) |
| 5 | `admin/requests/[requestId]/page.tsx` mock (15, 30) | Same approximation | Low (mock data) |
| 6 | **SQL `drawing_animation` has no reference-file surcharge**, but the code path requires `v_has_file = true` | Logical inconsistency: drawing always requires a file but the pricing code never adds the reference-file cost. This means the TypeScript side also doesn't add it. Consistent — both sides skip it. | ✅ Consistent |
| 7 | `config/plans.ts` defines plan→candy allocations (100, 250, 560) but no code currently links plans to candy purchases | These are "planned" values, not yet used in any creation flow | Low (future) |

---

## 6. Current `create_parent_request` Pricing Flow

### Step-by-step cost resolution inside the RPC:

1. **Type check** (line 110 of atomic_debit migration): `IF p_type NOT IN ('image', 'video', 'drawing_animation')` → raises `request_invalid_type` for unknown types.

2. **Duration validation** (lines 157–166): 
   - `video` and `drawing_animation`: must be `'short'`, `'medium'`, or `'long'` → `request_invalid_duration` otherwise
   - `image`: must be NULL → `request_duration_not_allowed` otherwise

3. **Cost calculation** (lines 281–305):
   - `image`: base 12; if file path supplied, +3 → total 12 or 15
   - `video`: short=40, medium=60, long=90; if file path supplied, +5 → 40/45, 60/65, 90/95
   - `drawing_animation`: short=35, medium=50, long=75; no file surcharge → 35, 50, 75

4. **Wallet resolution + row lock** (lines 312–316): `SELECT cw.id, cw.balance ... FOR UPDATE` — locks the wallet row.

5. **Balance check** (lines 326–329): `IF v_wallet_balance < v_candy_cost` → `INSUFFICIENT_CANDIES`.

6. **Order insert** (lines 338–356): stores `v_candy_cost` into `orders.candy_cost`.

7. **Wallet deduction** (lines 403–405): `balance - v_candy_cost`.

8. **Ledger append** (lines 416–432): `amount = -v_candy_cost`.

9. **Return** — `candy_cost` is returned in the result row.

The exact same `v_candy_cost` value is used for all three financial actions (order cost, wallet deduction, ledger amount). No rounding. No client influence.

---

## 7. Current Draft/Submission Price Flow

### Draft creation (client side — `app/(creation)/` pages)

1. User fills options on a Client Component (`"use client"`).
2. The page calls a TS calculator at every render (e.g., `calculateImageCandyCost`).
3. On "Continue and save" click, the draft is saved to `sessionStorage` via `saveCreationDraft()`.
4. The draft stores `estimatedCandyCost: number` (computed from TS constants) in the base type (`CreationDraftBase`).

### Draft readback

- `PendingCreationDraftCard` reads the draft from `sessionStorage` and displays `draft.estimatedCandyCost`.
- `CompleteCreationRequest` reads the draft and displays it via `CreationDraftSummaryCard`.

### Submission (`/api/requests/route.ts`)

1. API reads the draft JSON string from `formData.get("draft")`.
2. Calls `parseAndValidateDraft()` which:
   - Parses JSON
   - Checks version === 1
   - Dispatches by type to `validateImageDraft | validateVideoDraft | validateDrawingDraft`
   - Each validator extracts option keys (character, duration, etc.) AND computes `expectedCandyCost` from TS constants
3. API calls `supabase.rpc("create_parent_request", {...})` with normalized option keys (NOT the candy cost).
4. **The API does NOT pass `expectedCandyCost` to the RPC.** It passes only option keys.
5. The RPC recalculates cost entirely from the option keys using SQL hardcoded values.
6. The RPC's computed cost is the authority for wallet deduction and storage.

### Key finding: The `expectedCandyCost` in the submission flow is computed but NEVER used for any decision.
- `NormalizedRequest.expectedCandyCost` exists at `request-submission.ts:24`
- It is computed at lines 112, 154, 193
- But `route.ts` at lines 133–144 passes only option keys — `expectedCandyCost` is silently ignored
- No code compares `expectedCandyCost` to the RPC result

### Price-change vulnerabilities

- **Between draft creation and submission:** If a price changes, the displayed `estimatedCandyCost` will be stale, but the actual charge will use the new SQL price. The API never verifies the displayed cost against the charged cost.
- **Stale drafts** contain the old `estimatedCandyCost` value from when they were created.
- **No lock-in mechanism** — no quoted price, no expiry, no re-confirmation.

---

## 8. Public Pre-auth Pricing Requirements

| Page | Server/Client | Imports Pricing? | Needs Prices? | Works without Supabase? |
|------|--------------|-----------------|---------------|------------------------|
| `app/(creation)/create-image/page.tsx` | Client | `calculateImageCandyCost` from `candy-costs.ts` | Immediately (step 3 review) | Yes (TS constant) |
| `app/(creation)/request-video/page.tsx` | Client | `calculateVideoCandyCost` from `candy-costs.ts` | Immediately (step 3 review) | Yes (TS constant) |
| `app/(creation)/animate-drawing/page.tsx` | Client | `calculateDrawingAnimationCandyCost` from `candy-costs.ts` | Immediately (step 3 review) | Yes (TS constant) |
| `app/(marketing)/pricing/page.tsx` | Server | `config/plans.ts` | Immediately | Yes (import config) |
| `app/(marketing)/page.tsx` | Server | None (no pricing) | Not needed | Yes |
| `app/(auth)/complete-request/page.tsx` | Server (auth-gated) | None (reads draft) | After login | No (needs auth check) |

### Key requirements:
- All three creation pages are pre-auth (no login required).
- They compute costs client-side from TS constants.
- Prices must be available without a Supabase connection.
- Each page needs only a subset of all prices (image: 1 variant; video/drawing: 3 duration variants).
- The pricing page needs plan prices, not creation costs.
- Future design must keep prices readable without login.

---

## 9. Existing Pricing UI Locations

### Displays creation candy cost:

| Location | Path | Real/Mock/Placeholder |
|----------|------|----------------------|
| Create Image step 3 | `app/(creation)/create-image/page.tsx:384–392` | Real (TS constant) |
| Request Video step 3 | `app/(creation)/request-video/page.tsx:435–443` | Real (TS constant) |
| Animate Drawing step 3 | `app/(creation)/animate-drawing/page.tsx:402–410` | Real (TS constant) |
| Draft summary card | `components/creation/pending-creation-draft-card.tsx:120–123` | Real (from sessionStorage) |
| Pricing page | `app/(marketing)/pricing/page.tsx:62–67, 95–114` | Real (plans.ts) |
| Dashboard orders | `app/(dashboard)/dashboard/orders/page.tsx:23–80` | Mock |
| Dashboard home | `app/(dashboard)/dashboard/page.tsx:35–68` | Mock |
| Admin requests | `app/admin/requests/page.tsx:21–110` | Mock |
| Admin request detail | `app/admin/requests/[requestId]/page.tsx:43, 66, 148` | Mock |

### Displays candy balance:

| Location | Path | Data Type |
|----------|------|-----------|
| Dashboard home | `app/(dashboard)/dashboard/page.tsx` (mock balance "—") | Placeholder |
| Billing page | `app/(dashboard)/dashboard/billing/page.tsx` | Placeholder |

### Displays duration options:

| Location | Path | Data Type |
|----------|------|-----------|
| Request Video form | `app/(creation)/request-video/page.tsx:294–323` | Real (3 radio buttons: کوتاه/متوسط/بلند) |
| Animate Drawing form | `app/(creation)/animate-drawing/page.tsx:308–336` | Real (3 radio buttons) |
| Dashboard stubs | `app/(dashboard)/dashboard/request-video/page.tsx:79–86` | Placeholder (disabled) |
| Dashboard stubs | `app/(dashboard)/dashboard/animate-drawing/page.tsx:81–88` | Placeholder (disabled) |

### Displays plan pricing:

| Location | Path | Data Type |
|----------|------|-----------|
| Pricing page | `app/(marketing)/pricing/page.tsx:62–67` | Real (config/plans.ts) |

### No pricing shown:

| Location | Reason |
|----------|--------|
| Landing page `app/(marketing)/page.tsx` | Only has CTA cards, no prices |
| FAQ `app/(faq)/page.tsx` | Not inspected, likely placeholder |
| Safety page `app/(safety)/page.tsx` | Not inspected, likely placeholder |

---

## 10. Recommended Authoritative Pricing Schema

### Table: `public.creation_pricing`

```sql
CREATE TABLE public.creation_pricing (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_key  TEXT NOT NULL,
  request_type TEXT NOT NULL,
  option_key   TEXT,
  candy_cost   INTEGER NOT NULL CHECK (candy_cost > 0),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  label_fa     TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_creation_pricing_key ON public.creation_pricing (pricing_key);

CREATE INDEX idx_creation_pricing_active ON public.creation_pricing (request_type, is_active);
```

### Constraints and design choices:

| Concern | Decision |
|---------|----------|
| **Primary key** | `UUID` — standard Cartoona pattern |
| **Unique constraint** | `UNIQUE (pricing_key)` — stable machine-readable key |
| **Duplicate active rules** | NOT enforced by a unique constraint on request_type+option_key. A partial unique index `UNIQUE (request_type, COALESCE(option_key, '')) WHERE is_active = TRUE` could prevent duplicate active prices per variant. Recommended. |
| **`candy_cost > 0`** | CHECK — prevents free or negative prices. |
| **Stable request types** | `CHECK (request_type IN ('image', 'video', 'drawing_animation'))` |
| **Stable option keys** | `CHECK (option_key IN ('short', 'medium', 'long', NULL))` — NULL for image (no duration) |
| **`is_active`** | Soft deactivation; replaced rows get `is_active = FALSE`. |
| **`label_fa`** | Persian display label (not machine-readable, not in pricing_key). |
| **`sort_order`** | For admin UI ordering. |
| **No `updated_by`** | Defer to audit table (see Part 13). |

### Rationale for two-column unique vs. single key:

A single `pricing_key` is sufficient and simpler. The `(request_type, option_key)` patterns can be maintained as comments or a separate index but are not needed for uniqueness.

---

## 11. Proposed Stable Pricing Keys

| Key | request_type | option_key | Current Cost | Display Label (FA) |
|-----|-------------|-----------|-------------|-------------------|
| `image.default` | `image` | NULL | 12 | تصویر کارتونی |
| `image.reference_file` | `image` | NULL | 3 | (سربار فایل مرجع) |
| `video.short` | `video` | `short` | 40 | ویدیوی کوتاه |
| `video.medium` | `video` | `medium` | 60 | ویدیوی متوسط |
| `video.long` | `video` | `long` | 90 | ویدیوی بلند |
| `video.reference_file` | `video` | NULL | 5 | (سربار فایل مرجع) |
| `drawing_animation.short` | `drawing_animation` | `short` | 35 | جان‌بخشی کوتاه |
| `drawing_animation.medium` | `drawing_animation` | `medium` | 50 | جان‌بخشی متوسط |
| `drawing_animation.long` | `drawing_animation` | `long` | 75 | جان‌بخشی بلند |

### Notes on surcharges:

The reference-file surcharge (image +3, video +5, drawing none) is not a separate pricing variant but an additive modifier. Two design options:

**Option A — Surcharge as separate rows:**
Reference-file surcharges get their own pricing keys (`image.reference_file`, `video.reference_file`). The RPC queries the base price + surcharge price when a file is present.

**Option B — Surcharge baked into price:**
Each variant exists in two forms: `image.default` (12) and `image.with_file` (15). This doubles rows but keeps the RPC lookup simpler (single row per variant).

**Recommendation: Option A (surcharge rows).** Fewer rows, clearer semantics, easier admin management (change base price without changing file surcharge).

### The 11 actual pricing rows would be:

1. `image.default` → 12
2. `image.reference_file` → 3 (additive)
3. `video.short` → 40
4. `video.medium` → 60
5. `video.long` → 90
6. `video.reference_file` → 5 (additive)
7. `drawing_animation.short` → 35
8. `drawing_animation.medium` → 50
9. `drawing_animation.long` → 75

Note: `image.reference_file` and `video.reference_file` have no `option_key` (they are surcharges, not duration variants). Their `option_key` is NULL, and their `request_type` distinguishes them.

---

## 12. Recommended Public Read Strategy

### Recommendation: Option D (Server Component fetch + Option A (anon SELECT through RLS) as fallback

**Primary approach — Server Component fetch:**
1. Create a lightweight RPC or direct query: `SELECT pricing_key, request_type, option_key, candy_cost, label_fa, sort_order FROM public.creation_pricing WHERE is_active = TRUE ORDER BY sort_order`.
2. Build a data-loading function in `lib/pricing/load-pricing.ts`:
   - During SSR: fetch via `createServerSupabaseClient()` (authenticated or anon, both can SELECT)
   - Cache the result in a simple server-side variable or React cache
   - Pass pricing data as props to Client Components
3. Caching: use `React.cache()` for per-request deduplication, or `unstable_cache` for longer TTL.

**Fallback — Public RLS:**
Grant `SELECT` to `anon` on `public.creation_pricing WHERE is_active = TRUE`. This allows direct browser queries from Client Components without a server round-trip. However, this is less cacheable and exposes the table structure more than necessary.

**Rationale:**
- Server fetch keeps the DB schema invisible to clients.
- Pricing info is not sensitive — RLS anon SELECT is safe.
- Next.js Server Components can embed fetched prices into server-rendered HTML.
- Client Components receive prices as props — no extra client fetch needed after hydration.
- Future admin price changes are visible on next page load (no stale client cache).

---

## 13. Recommended RPC Lookup Behavior

### The future `create_parent_request` pricing resolution:

```sql
-- Pseudocode for the RPC pricing lookup:
DECLARE
  v_base_price INTEGER;
  v_file_surcharge INTEGER;
  v_total_cost INTEGER;
BEGIN
  -- 1. Look up base price
  SELECT candy_cost INTO v_base_price
  FROM public.creation_pricing
  WHERE pricing_key = CASE p_type
    WHEN 'image' THEN 'image.default'
    WHEN 'video' THEN 'video.' || p_duration_key
    WHEN 'drawing_animation' THEN 'drawing_animation.' || p_duration_key
  END
  AND is_active = TRUE
  FOR SHARE;  -- or no lock needed since pricing changes are rare

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRICING_KEY_NOT_FOUND'
      USING HINT = 'هزینه برای این نوع درخواست تعریف نشده است.';
  END IF;

  -- 2. Look up file surcharge if applicable
  v_total_cost := v_base_price;
  IF v_has_file THEN
    SELECT candy_cost INTO v_file_surcharge
    FROM public.creation_pricing
    WHERE pricing_key = CASE p_type
      WHEN 'image' THEN 'image.reference_file'
      WHEN 'video' THEN 'video.reference_file'
      ELSE NULL  -- drawing has no surcharge
    END
    AND is_active = TRUE;

    IF v_file_surcharge IS NOT NULL THEN
      v_total_cost := v_total_cost + v_file_surcharge;
    END IF;
  END IF;

  -- 3. Store on order, deduct from wallet, write to ledger (as before)
  -- Uses v_total_cost as the single source of truth.
END;
```

### Error codes for missing/inactive prices:

| Condition | Error Code | HTTP Status | Hint (FA) |
|-----------|-----------|-------------|-----------|
| Pricing key not found | `PRICING_KEY_NOT_FOUND` | 500 | هزینه برای این نوع درخواست تعریف نشده است |
| Pricing row inactive | `PRICING_INACTIVE` | 500 | این نوع درخواست موقتاً غیرفعال شده است |
| Multiple active rows match | `PRICING_AMBIGUOUS` | 500 | خطای داخلی: قیمت تکراری |
| candy_cost is NULL or ≤ 0 | `PRICING_INVALID_COST` | 500 | خطای داخلی: هزینه نامعتبر |

**The RPC must fail closed — never use a default price or fallback.** If the catalog is empty or misconfigured, requests must be rejected.

---

## 14. Recommended Missing/Inactive-Price Errors

As above. The principle: **fail hard, fail early.** If pricing catalog is missing any required entry, the API returns 500 with a clear error code so the admin knows pricing is misconfigured.

No silent fallback to TypeScript constants or hardcoded SQL values.

---

## 15. Recommended Price-Change Semantics

### Recommendation: Option B (Update in place with active/deactivate)

**Why not Option A (update in place):** No audit trail of what price was charged for historical orders.  
**Why not Option C (versioned with effective dates):** Over-engineering for current state. No admin price management exists yet. No Stripe/payment integration exists.

**Recommended model — Deactivate-and-replace:**
1. When an admin changes a price:
   - Set existing row `is_active = FALSE`.
   - INSERT a new row with the same `pricing_key`, new `candy_cost`, `is_active = TRUE`.
   - Record the change in `audit_logs` (who, what, when, old value, new value).
2. Historical orders retain their original `orders.candy_cost` — this is already stored on the row.
3. Historical ledger entries remain immutable (trigger prevents mutation).
4. Referral/payment logic will use `orders.candy_cost` (historical), never the catalog price.

This requires no effective_from/effective_to columns. Audit logs are the history.

---

## 16. Recommended Future Admin-Management Model

### Future admin price management requirements:

1. **View current prices** — display all rows where `is_active = TRUE`, grouped by `request_type`, sorted by `sort_order`.
2. **Change candy cost** — update or deactivate+insert (see Part 15).
3. **Activate/deactivate variants** — flip `is_active` (soft deletion).
4. **Validate positive integers** — `candy_cost > 0` enforced by CHECK constraint.
5. **Prevent deleting prices referenced by historical behavior** — not needed since `orders.candy_cost` stores the value at time of order; the pricing row can be deactivated without affecting historical orders.
6. **Record who changed a price** — store `admin_id` in `audit_logs`.
7. **Record previous and new values** — store old/new `candy_cost` in `audit_logs`.
8. **Require admin or super_admin** — the management RPC checks `auth.uid()` role.
9. **Invalidate public pricing cache** — not critical since the pricing read is per-request from DB. If server caching is added later, a simple time-based invalidation suffices.

### Audit table: Defer until admin UI work.

An `audit_logs` table already exists in the schema. When admin price management is implemented, we insert:
```sql
INSERT INTO public.audit_logs (admin_id, action, entity_type, entity_id, old_data, new_data)
VALUES (v_admin_id, 'pricing_update', 'creation_pricing', v_pricing_key, jsonb_build_object('candy_cost', v_old_cost), jsonb_build_object('candy_cost', v_new_cost));
```

No separate pricing audit table is needed now.

---

## 17. Recommended RLS/Grants

### Future `public.creation_pricing` permissions:

| Role | SELECT | INSERT | UPDATE | DELETE |
|------|--------|--------|--------|--------|
| `anon` | Active rows only (`is_active = TRUE`) | No | No | No |
| `authenticated` (parent) | Active rows only | No | No | No |
| `authenticated` (admin/super_admin) | All rows | No (use RPC) | No (use RPC) | No (use RPC) |
| Pricing management RPC (`SECURITY DEFINER`) | All rows | Yes | Yes (deactivate) | No (soft deactivation only) |

### RLS policy for anon/authenticated:

```sql
CREATE POLICY "creation_pricing_public_read_active"
  ON public.creation_pricing
  FOR SELECT
  USING (is_active = TRUE);
```

This allows both anon and authenticated users to read active prices. Direct writes from the browser are impossible (no INSERT/UPDATE/DELETE grants).

### Grants:

```sql
GRANT SELECT ON public.creation_pricing TO anon, authenticated;
```

One public table with RLS is sufficient. No separate table needed for public vs. internal prices.

---

## 18. Migration/Backfill Plan

### Migration steps (single migration, sequential):

1. **Create the pricing table** (`public.creation_pricing`) with all constraints (see Part 10).

2. **Insert current SQL prices exactly:**

```sql
INSERT INTO public.creation_pricing (pricing_key, request_type, option_key, candy_cost, is_active, label_fa, sort_order) VALUES
  ('image.default',           'image',             NULL,   12, TRUE, 'تصویر کارتونی',                        10),
  ('image.reference_file',    'image',             NULL,    3, TRUE, 'سربار فایل مرجع تصویر',                 15),
  ('video.short',             'video',             'short', 40, TRUE, 'ویدیوی کوتاه',                         20),
  ('video.medium',            'video',             'medium',60, TRUE, 'ویدیوی متوسط',                         30),
  ('video.long',              'video',             'long',  90, TRUE, 'ویدیوی بلند',                          40),
  ('video.reference_file',    'video',             NULL,    5, TRUE, 'سربار فایل مرجع ویدیو',                 45),
  ('drawing_animation.short',  'drawing_animation', 'short', 35, TRUE, 'جان‌بخشی کوتاه',                       50),
  ('drawing_animation.medium', 'drawing_animation', 'medium',50, TRUE, 'جان‌بخشی متوسط',                       60),
  ('drawing_animation.long',   'drawing_animation', 'long',  75, TRUE, 'جان‌بخشی بلند',                        70);
```

3. **Add constraints:**
   - `CHECK (candy_cost > 0)`
   - `CHECK (request_type IN ('image', 'video', 'drawing_animation'))`
   - `CHECK (option_key IN ('short', 'medium', 'long', NULL))`
   - `UNIQUE (pricing_key)`
   - Partial unique index: `UNIQUE (request_type, COALESCE(option_key, '')) WHERE is_active = TRUE`

4. **Enable RLS:** `ALTER TABLE public.creation_pricing ENABLE ROW LEVEL SECURITY;`

5. **Add read policies:** `creation_pricing_public_read_active` (see Part 17).

6. **Grant SELECT** to `anon, authenticated`.

7. **Replace `create_parent_request` pricing branches** with table lookup:
   - Remove the hardcoded `IF p_type = 'image' THEN v_candy_cost := 12 ... END IF;` block.
   - Add pricing lookups from `public.creation_pricing` (see Part 13).
   - Preserve the existing RPC contract (parameters, return type, validation, auth).
   - Preserve wallet deduction, ledger insert, idempotency.
   - Add error codes: `PRICING_KEY_NOT_FOUND`, `PRICING_INACTIVE`, `PRICING_AMBIGUOUS`, `PRICING_INVALID_COST`.

8. **The migration must fail** if any INSERT for current prices has a duplicate key or constraint violation. Use `ON CONFLICT DO NOTHING` is **not** recommended — the migration should fail loudly if the catalog can't be populated.

9. **Verify every current variant** resolves to exactly one price by calling a test function that exercises every pricing key.

---

## 19. TypeScript Replacement Plan

### What stays in TypeScript:

| Item | Reason |
|------|--------|
| `FormDuration` type (`"کوتاه"|"متوسط"|"بلند"`) | Persian form labels needed for UI |
| `InternalDuration` type (`"short"|"medium"|"long"`) | Stable mapping keys |
| Duration option arrays (creation pages) | UI needs display values |
| `PricingKey` union type | Shared type for RPC calls and API responses |
| Display-order fallback | If DB load fails, fall back to hardcoded display order |
| Type definitions | Always safe in types/ |

### What is removed from TypeScript:

| File | What's removed |
|------|---------------|
| `config/candy-costs.ts` | **Entire file.** All numeric constants, all calculator functions, all input types. |
| `lib/requests/request-submission.ts` | **Remove `expectedCandyCost` computation.** Lines 112, 154, 193. The `expectedCandyCost` field in `NormalizedRequest` is deleted (it's unused anyway). Remove the three `calculate*CandyCost` imports. |

### What replaces it:

1. **New file `lib/pricing/pricing-keys.ts`** — defines only the stable pricing key strings and mapping functions:

```ts
export type PricingKey = 
  | 'image.default'
  | 'image.reference_file'
  | 'video.short'
  | 'video.medium'
  | 'video.long'
  | 'video.reference_file'
  | 'drawing_animation.short'
  | 'drawing_animation.medium'
  | 'drawing_animation.long';

export function resolvePricingKey(type: string, duration: string | null): PricingKey { ... }
```

2. **New file `lib/pricing/load-pricing.ts`** — server-only function to fetch active prices:

```ts
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function loadActivePricing() { ... }  // Returns PricingEntry[]
```

3. **Update creation pages** to fetch pricing server-side (or accept as props) instead of importing `calculateImageCandyCost`.

4. **Keep `config/plans.ts`** — plan pricing is separate from creation pricing; not duplicated in SQL.

---

## 20. Files That Must Stop Importing Numeric Cost Constants

| File | Currently imports | Replacement |
|------|-----------------|-------------|
| `app/(creation)/create-image/page.tsx:12` | `calculateImageCandyCost` from `@/config/candy-costs` | Fetch pricing via server call or prop |
| `app/(creation)/request-video/page.tsx:12` | `calculateVideoCandyCost` from `@/config/candy-costs` | Same |
| `app/(creation)/animate-drawing/page.tsx:10` | `calculateDrawingAnimationCandyCost` from `@/config/candy-costs` | Same |
| `lib/requests/request-submission.ts:4` | All three `calculate*CandyCost` functions | Remove entirely (`expectedCandyCost` is unused) |
| `lib/creation/creation-draft.ts:1` | `FormDuration` type from `@/config/candy-costs` | Move `FormDuration` to `lib/pricing/pricing-keys.ts` |

After removing `config/candy-costs.ts`, the file can be deleted entirely.

---

## 21. Testing Plan

### Database tests (SQL-level, via `supabase db query`):

1. **Every pricing key exists** — `SELECT count(*) FROM public.creation_pricing WHERE is_active = TRUE` = 9.
2. **Every price is positive** — `SELECT count(*) FROM public.creation_pricing WHERE candy_cost <= 0` = 0.
3. **No duplicate active keys** — `SELECT pricing_key, count(*) FROM public.creation_pricing WHERE is_active = TRUE GROUP BY pricing_key HAVING count(*) > 1` = 0.
4. **Public anon SELECT** — test with anon role that only active rows are returned.
5. **Browser cannot write** — test with anon role that INSERT/UPDATE/DELETE fails.
6. **RPC uses DB price** — test with known options, verify `candy_cost` in return matches pricing table.
7. **Changing a price changes next request cost** — update price, submit new request, verify new cost is used.
8. **Missing pricing key fails** — deactivate a required pricing row, call RPC, verify `PRICING_KEY_NOT_FOUND`.
9. **Inactive pricing rule fails** — set `is_active = FALSE`, call RPC, verify `PRICING_INACTIVE`.
10. **Existing orders unchanged** — after price change, old `orders.candy_cost` remains unchanged.
11. **Ledger immutable** — existing ledger rows unchanged after price change.
12. **Atomic wallet debit still works** — full end-to-end: submit request, verify deduction + ledger entry.

### Application tests (Playwright or Vitest):

13. **Public creation pages render current values** — check that create-image page displays price matching pricing table.
14. **`expectedCandyCost` removed** — verify `NormalizedRequest` no longer has `expectedCandyCost` field.
15. **`config/candy-costs.ts` deleted** — verify file no longer exists.

---

## 22. Documentation Drift

| Document | Inaccurate Claim | Correct State |
|----------|-----------------|---------------|
| `.claude/summary.md:3` | "29 routes are static placeholders" | **42 routes** — build shows 42 routes |
| `.claude/summary.md:4` | "`/api/requests` is the only real API" | Correct — still the only API with business logic |
| `.claude/summary.md:4` | "No storage bucket RLS" | Correct — still no storage bucket RLS |
| `.claude/summary.md:37` | "Costs are duplicated between SQL and TypeScript" | **Correct** — SQL RPC and TS config/candy-costs.ts have identical hardcoded values |
| `docs/FEATURES.md` | No candy wallet/ledger/atomic debit mentioned | Wallet, ledger, RLS, idempotency, atomic debit all implemented but not documented |
| `docs/ROADMAP.md` | Pricing consolidation in future MVP | Pricing audit is happening now; no mention of candy wallet/ledger |
| `docs/DECISIONS.md:75` | `DECISIONS.md` references `config/candy-costs.ts` as current design | Still correct — it documents the current duplicated-cost state |
| `docs/ARCHITECTURE.md` | No mention of pricing or candy costs in architecture | Needs update to reflect wallet/ledger/pricing model |

---

## 23. Exact Files for the First Implementation Task

The implementation should be split into three tasks. Here are the exact files for each:

### Task 1: Creation pricing table + migration

| File | Action |
|------|--------|
| `supabase/migrations/20260727100000_create_creation_pricing.sql` | **Create** — new migration with table creation, 9 inserts, constraints, RLS, grants |
| `db/schema.sql` | **Update** — document the new table and updated RPC pricing behavior |
| `docs/AUDIT_PRICING.md` | **Keep** — this audit document as reference |

### Task 2: Replace RPC pricing with catalog lookup

| File | Action |
|------|--------|
| `supabase/migrations/20260727100000_create_creation_pricing.sql` | **Append** — the `CREATE OR REPLACE FUNCTION public.create_parent_request(...)` replacement WITH catalog lookup and pricing error codes |
| `lib/pricing/pricing-keys.ts` | **Create** — stable pricing key types and mapping functions |
| `lib/pricing/load-pricing.ts` | **Create** — server-side pricing loader |
| `types/database.ts` | **Update** — add `DbCreationPricing` type, add new error codes to `RequestSubmissionErrorCode` |
| `app/api/requests/route.ts` | **Update** — add HTTP status mapping for `PRICING_KEY_NOT_FOUND` (500), `PRICING_INACTIVE` (500) |

### Task 3: Remove TypeScript costs and update consumers

| File | Action |
|------|--------|
| `config/candy-costs.ts` | **Delete** — entire file |
| `lib/requests/request-submission.ts` | **Edit** — remove `expectedCandyCost` computation and all imports from `candy-costs.ts`; remove `expectedCandyCost` from `NormalizedRequest` |
| `lib/creation/creation-draft.ts` | **Edit** — remove `estimatedCandyCost` from `CreationDraftBase`; move `FormDuration` type to `lib/pricing/pricing-keys.ts` |
| `app/(creation)/create-image/page.tsx` | **Edit** — replace `calculateImageCandyCost` call with server-fetched pricing data or prop |
| `app/(creation)/request-video/page.tsx` | **Edit** — same |
| `app/(creation)/animate-drawing/page.tsx` | **Edit** — same |
| `components/creation/pending-creation-draft-card.tsx` | **Edit** — remove display of `estimatedCandyCost` from draft; replace with pricing from context/props or live fetch |
| `components/creation/complete-creation-request.tsx` | **Edit** — same |

---

## 24. Implementation Split (3 Focused Tasks)

### Task A: "Database pricing catalog" (migration + table)
- Create migration with `public.creation_pricing` table, 9 rows, constraints, RLS, grants.
- Document in `db/schema.sql`.
- **Migration must fail if pricing rows can't be inserted.**

### Task B: "RPC catalog lookup" (replace hardcoded SQL costs)
- Create `lib/pricing/pricing-keys.ts` with stable key types and `resolvePricingKey()`.
- Create `lib/pricing/load-pricing.ts` with server-side fetch function.
- Replace the cost-calculation block in `create_parent_request` with table lookup from `public.creation_pricing`.
- Add `PRICING_KEY_NOT_FOUND`, `PRICING_INACTIVE`, `PRICING_AMBIGUOUS`, `PRICING_INVALID_COST` error codes.
- Update API route error mappings.
- Update TypeScript error code union.

### Task C: "Remove client-side cost duplication" (delete config + update pages)
- Delete `config/candy-costs.ts`.
- Remove `expectedCandyCost` from `NormalizedRequest` and `request-submission.ts`.
- Remove `estimatedCandyCost` from `CreationDraftBase` and `creation-draft.ts`.
- Update all three creation pages to use fetched pricing instead of TS calculators.
- Update `PendingCreationDraftCard` to display cost from source of truth.
- Update `CompleteCreationRequest` to display cost from source of truth.

### Dependency order: Task A → Task B → Task C
- A must happen first (table must exist for RPC to query).
- B must happen second (RPC must use table before TS constants are removed).
- C must happen last (client code must work with the new pricing source before removing the old one).
